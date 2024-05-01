import {
    CognitoIdentityProvider,
    InitiateAuthResponse,
    RespondToAuthChallengeResponse,
    UnauthorizedException
} from "@aws-sdk/client-cognito-identity-provider";
import * as process from "process";
import {createHmac} from "crypto";
import _, {toCamel} from "@app/util";
import {
    badRequestError,
    HttpError,
    internalServerError,
    Middleware,
    pipeline,
    requireLambdaAuth,
    TracedEvent
} from "@app/lambda";
import Paths from "./paths";
import * as Schemas from "./schemas";
import SessionData, {SessionContext} from "@src/authorizer/session";
import {userPoolClientDetails, userPoolDetails} from "@src/cognito";
import {configure} from "@app/diagnostics";
import OidcTokens from "@src/authorizer/oidc_tokens";
import {jwtDecode} from "jwt-decode";
import {initModuleVariables} from "@src/authorizer/ctx";
import {Static} from "@sinclair/typebox";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import UserRepo, {invalidAliasException, UserAttribute} from "./user"

const ClientId = process.env.OAUTH_CLIENT_ID ?? _.throw("Missing required OAUTH_CLIENT_ID env variable")
const UserPoolId = process.env.USER_POOL_ID ?? _.throw("Missing required USER_POOL_ID env variable")

/**
 * Static initialisation loads user pool details.
 */
export async function __init() {
    const {ClientSecret} = await userPoolClientDetails(UserPoolId, ClientId, cognito)
    if (ClientSecret === undefined)
        throw new Error("Cannot load UserPool client secret.")
    const {UsernameAttributes, AliasAttributes} = await userPoolDetails(UserPoolId, cognito)
    return {ClientSecret, UsernameAttributes, AliasAttributes}
}

declare module "@aws-sdk/client-cognito-identity-provider" {
    interface UnauthorizedException extends HttpError {
    }
}
Object.defineProperty(UnauthorizedException.prototype, 'statusCode', {
    value: '401', writable: false
})

configure({triggers: {request: true}})

const dynamo = new DynamoDB()
const cognito = new CognitoIdentityProvider()

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .withRoutes(Paths)
    .parseJsonBody()
    .do(async function (this: Middleware, e: TracedEvent, ctx: any) {
        const response = await this.next(e, ctx)
        //cleanup AWS noise
        delete response?.$metadata
        return toCamel(response)
    })
    .done(async function (req) {
        switch (req.routeKey) {
//#region Session
            case "POST /user/signin": {
                const {ClientSecret, UsernameAttributes} = await __init()
                const {body} = req.parse()
                const {USERNAME: usernameOrAlias} = body.authParameters
                const userRepo = new UserRepo(req, dynamo)
                const poolUseUsernameAttributes = (UsernameAttributes?.length ?? 0) > 0;
                const user = await userRepo.fetchLocked(usernameOrAlias, {
                    allowUnverifiedAlias: poolUseUsernameAttributes
                })

                try {
                    const clientMetadata = {
                        ...body.clientMetadata,
                        'user': JSON.stringify(user.attributes)
                    }

                    const auth = await cognito.initiateAuth({
                        AuthFlow: body.authFlow,
                        ClientMetadata: clientMetadata,
                        AuthParameters: {
                            ...body.authParameters,
                            "SECRET_HASH": secretHash(user.username, ClientSecret),
                            'USERNAME': user.username
                        },
                        ClientId,
                    })
                    return await processAuthResponse(auth);
                } finally {
                    await user.unlock()
                }
            }
            case "POST /user/signin/challenge": {
                const {ClientSecret, UsernameAttributes} = await __init()
                const {body} = req.parse()
                const {USERNAME: usernameOrAlias} = body.challengeResponses
                const userRepo = new UserRepo(req, dynamo)
                const poolUseUsernameAttributes = (UsernameAttributes?.length ?? 0) > 0;
                const user = await userRepo.fetchLocked(usernameOrAlias, {
                    allowUnverifiedAlias: poolUseUsernameAttributes
                })
                try {
                    const auth = await cognito.respondToAuthChallenge({
                        Session: body.session,
                        ChallengeName: body.challengeName,
                        ChallengeResponses: {
                            ...body.challengeResponses,
                            'USERNAME': user.username,
                            "SECRET_HASH": secretHash(user.username, ClientSecret),
                        },
                        ClientMetadata: body.clientMetadata,
                        ClientId,
                    })
                    return await processAuthResponse(auth);
                } finally {
                    await user.unlock()
                }
            }
            case "GET /user/session": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.user;
                return {
                    accessToken: session.access_token,
                    idToken: session.id_token,
                    profile: session.profile,
                    expiresAt: session.expires_at
                } satisfies Static<typeof Schemas.GetSessionResponse>
            }
            case 'POST /user/session': {
                requireLambdaAuth<SessionContext>(req)
                await initModuleVariables()
                const session = await SessionData.fetch(req.user.id)
                if (session === null) throw new Error("Cannot find user session")
                const tokens = await OidcTokens.refresh(session.refreshToken)
                if (tokens === null) {
                    throw badRequestError("Cannot refresh session.")
                }
                const newSession = session.withTokens(tokens)
                await Promise.all([newSession.create(), session.remove()])
                return newSessionResponse(newSession)
            }
            case "DELETE /user/session": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.user;
                return await cognito.globalSignOut({
                    AccessToken: session.access_token
                })
            }
//#endregion
//#region SignUp
            case "POST /user": {
                const {ClientSecret, UsernameAttributes} = await __init()
                const {body} = req.parse()

                const userDataRepo = new UserRepo(req, dynamo)

                async function signUp(username: string) {
                    const aliases = userDataRepo.aliases(body.userAttributes ?? [])
                    return await cognito.signUp({
                        Username: username,
                        Password: body.password,
                        UserAttributes: aliases?.map(x => ({Name: x.name, Value: x.value})),
                        ClientMetadata: body.clientMetadata,
                        ValidationData: body.validationData?.map(x => ({Name: x.name, Value: x.value})),
                        ClientId,
                        SecretHash: secretHash(username, ClientSecret)
                    })
                }

                const poolUseUsernameAttributes = (UsernameAttributes?.length ?? 0) > 0;
                if (poolUseUsernameAttributes) {

                    /**
                     * When User Pool use 'username attributes' it
                     * 1. accept username and put it into either email or phone_number
                     * 2. generates username.
                     * 3. allows duplicate alias attributes in users until they are not used as a username
                     * 4. allows change of the username attribute value
                     *
                     * This is a problem because fpr multiple reasons
                     * 1. We need to know username before creating a user
                     * 2. We want to create user before interacting with cognito to guarantee alias uniqueness.
                     *
                     * Solution:
                     * 1. SignUp user first to get user id. Cognito guarantee username attribute uniqueness.
                     * 2. Do not allow alias attributes to guarantee cognito does not create duplicates.
                     * 3. Read cognito right after signup and create aliases in Dynamo.
                     *
                     * We are guaranteed to read just one alias from Cognito. Resulting DB state is
                     * 1. Username guid which is different from any alias attribute.
                     * 2. Username attribute mapping to the username guid
                     * 3. No other alias attributes.
                     */

                    const aliases = userDataRepo.aliases(body.userAttributes ?? [])
                    if (aliases.length > 0) {
                        throw invalidAliasException()
                    }

                    const response = await signUp(body.username)
                    const userId = response.UserSub
                    if (userId === undefined)
                        throw internalServerError("Unexpected error - Cognito didn't generate user id")
                    const cognitoAliases = await fetchCognitoAttributes(userId)
                    const attributes = userDataRepo.normalAttributes(body.userAttributes ?? [])
                    await userDataRepo.create(userId, 'trusted', attributes.concat(cognitoAliases))
                    return response
                } else {
                    /**
                     * In this mode username cannot be equal to any of alias attributes which is guaranteed by the user repo.
                     */
                    await userDataRepo.create(body.username, 'user', body.userAttributes)
                    return await signUp(body.username)
                }
            }
            case "POST /user/confirm": {
                const {ClientSecret, UsernameAttributes} = await __init()
                const {body} = req.parse()
                const userDataRepo = new UserRepo(req, dynamo)
                const poolUseUsernameAttributes = (UsernameAttributes?.length ?? 0) > 0;
                const user = await userDataRepo.fetchLocked(body.username, {
                    allowUnverifiedAlias: poolUseUsernameAttributes
                })
                try {
                    const cognitoResponse = await cognito.confirmSignUp({
                        Username: user.username,
                        ConfirmationCode: body.confirmationCode,
                        ClientMetadata: body.clientMetadata,
                        ClientId,
                        SecretHash: secretHash(user.username, ClientSecret)
                    })
                    const cognitoAttributes = await fetchCognitoAttributes(body.username);
                    await user.updateAttributes('trusted', cognitoAttributes)
                    return cognitoResponse
                } finally {
                    await user.unlock()
                }
            }
            case "POST /user/resend_confirmation_code": {
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                const repo = new UserRepo(req, dynamo)
                const {username} = await repo.lookupAlias(body.username)
                return await cognito.resendConfirmationCode({
                    Username: username,
                    ClientMetadata: body.clientMetadata,
                    ClientId,
                    SecretHash: secretHash(username, ClientSecret)
                })
            }
//#endregion
//#region Attributes
            case 'GET /user/attributes': {
                requireLambdaAuth<SessionContext>(req)
                const username = req.user.profile['cognito:username']
                const userRepo = new UserRepo(req, dynamo)
                const user = await userRepo.fetch(username)
                return user.attributes satisfies Readonly<Static<typeof req.route.success>>
            }
            case "PUT /user/attributes": {
                requireLambdaAuth<SessionContext>(req)
                const {body} = req.parse()
                const username = req.user.profile['cognito:username']
                let codeDeliveryDetailsList

                const userRepo = new UserRepo(req, dynamo)
                const user = await userRepo.fetchLocked(username)
                try {
                    const bodyAttributes = body.userAttributes.map(x => {
                        if (x.name === 'phone_number')
                            return {
                                ...x,
                                name: 'phone'
                            }
                        return x
                    });
                    const aliasAttributes = userRepo.aliases(bodyAttributes)
                    req.tracer.info("Update Cognito attributes", {attributes: aliasAttributes})
                    if (aliasAttributes.length > 0) {
                        const response = await cognito.updateUserAttributes({
                            UserAttributes: aliasAttributes.map(x => ({Name: x.name, Value: x.value})),
                            ClientMetadata: body.clientMetadata,
                            AccessToken: req.user.access_token,
                        })
                        codeDeliveryDetailsList = response.CodeDeliveryDetailsList
                    }
                    const normalAttributes = userRepo.normalAttributes(bodyAttributes)
                    const cognitoAttributes = await fetchCognitoAttributes(user.username)
                    const attrs = _(normalAttributes).concat(cognitoAttributes).keyBy('name').map().value()
                    await user.updateAttributes('trusted', attrs)
                    return {
                        attributes: user.attributes,
                        codeDeliveryDetailsList
                    }
                } finally {
                    await user.unlock()
                }
            }
            case 'DELETE /user/attributes': {
                requireLambdaAuth<SessionContext>(req)
                const {body} = req.parse()
                const username = req.user.profile['cognito:username']
                const userRepo = new UserRepo(req, dynamo)
                const user = await userRepo.fetchLocked(username)
                try {
                    const aliasAttributes = userRepo.aliases(body.userAttributesNames)
                    if (aliasAttributes.length > 0) {
                        await cognito.deleteUserAttributes({
                            UserAttributeNames: body.userAttributesNames,
                            AccessToken: req.user.access_token
                        })
                    }
                    await user.deleteAttributes(body.userAttributesNames)
                    return {} satisfies Static<typeof req.route.success>
                } finally {
                    await user.unlock()
                }
            }
//#endregion
//#region Password
            case "POST /user/password": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.user;

                const {body} = req.parse()
                return await cognito.changePassword({
                    PreviousPassword: body.previousPassword,
                    ProposedPassword: body.proposedPassword,
                    AccessToken: session.access_token,
                })
            }
            case "POST /user/password/forgot": {
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                const userRepo = new UserRepo(req, dynamo)
                const {username} = await userRepo.lookupAlias(body.username)
                return await cognito.forgotPassword({
                    ClientMetadata: body.clientMetadata,
                    Username: username,
                    ClientId,
                    SecretHash: secretHash(username, ClientSecret)
                })
            }
            case "POST /user/password/confirm": {
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                const userRepo = new UserRepo(req, dynamo)
                const {username} = await userRepo.lookupAlias(body.username)
                return await cognito.confirmForgotPassword({
                    Username: username,
                    ClientMetadata: body.clientMetadata,
                    Password: body.password,
                    ConfirmationCode: body.confirmationCode,
                    ClientId,
                    SecretHash: secretHash(username, ClientSecret),
                })
            }
//#endregion
//#region Devices
            case "GET /user/devices": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.user;
                const {body} = req.parse()
                return await cognito.listDevices({
                    Limit: body.limit,
                    PaginationToken: body.paginationToken,
                    AccessToken: session.access_token,
                })
            }
            case "GET /user/device/{id}": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.user;
                return await cognito.getDevice({
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: session.access_token,
                })
            }
            case "PUT /user/device/{id}/confirm": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.user;

                const {body} = req.parse()
                return await cognito.confirmDevice({
                    DeviceName: body.deviceName,
                    DeviceSecretVerifierConfig: {
                        Salt: body.deviceSecretVerifierConfig?.salt,
                        PasswordVerifier: body.deviceSecretVerifierConfig?.passwordVerifier,
                    },
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: session.access_token,
                })
            }
            case "DELETE /user/device/{id}": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.user;
                return await cognito.forgetDevice({
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: session.access_token,
                })
            }
            case "PUT /user/device/{id}": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.user
                const {body} = req.parse()
                return await cognito.updateDeviceStatus({
                    DeviceKey: req.pathParameters?.['id'],
                    DeviceRememberedStatus: body.deviceRememberedStatus,
                    AccessToken: session.access_token,
                })
            }
        }

//#endregion

        async function fetchCognitoAttributes(username: string): Promise<UserAttribute[]> {
            const cognitoUser = await cognito.adminGetUser({Username: username, UserPoolId})
            req.tracer.info("Cognito attributes", {attributes: cognitoUser.UserAttributes})
            const verifiers = _(cognitoUser.UserAttributes)
                .filter(x => x.Name?.endsWith('_verified') ?? false)
                .keyBy('Name')
                .mapKeys((_1, k) => k.substring(0, k.length - 9 /*_verified.length*/))
                .mapValues('Value')
                .value()
            return _(cognitoUser.UserAttributes)
                .map(function (x) {
                    if (x.Name === undefined || x.Value === undefined) {
                        return undefined
                    }
                    if (x.Name.endsWith('_verified')) return undefined
                    const verified = verifiers[x.Name]
                    if (verified === 'true')
                        return {name: x.Name, value: x.Value, verified: true}
                    return {name: x.Name, value: x.Value}
                })
                .compact()
                .value()
        }

        async function processAuthResponse(auth: InitiateAuthResponse | RespondToAuthChallengeResponse) {
            if (auth.AuthenticationResult !== undefined) {
                const {AccessToken, IdToken, RefreshToken, ExpiresIn} = auth.AuthenticationResult
                if (AccessToken === undefined || IdToken === undefined ||
                    RefreshToken === undefined || ExpiresIn === undefined) {
                    throw internalServerError("Unexpected OIDC provider response").withContext("processAuthResponse", {
                        cognitoResponse: auth.AuthenticationResult
                    })
                }
                return await createNewSession(RefreshToken, IdToken, AccessToken, ExpiresIn);
            } else {
                return auth
            }
        }
    })


function secretHash(username: string, clientSecret: string) {
    const hasher = createHmac('sha256', clientSecret);
    hasher.update(`${username}${ClientId}`);
    return hasher.digest('base64');
}

async function createNewSession(RefreshToken: string, IdToken: string, AccessToken: string, ExpiresIn: number) {
    await initModuleVariables()
    const tokens = new OidcTokens(RefreshToken, IdToken, AccessToken, ExpiresIn)
    const session = SessionData.createWithTokens(tokens)
    await session.create()
    return newSessionResponse(session);
}

function newSessionResponse(session: SessionData) {
    const cookie = session.makeCookie()
    return {
        statusCode: 200,
        headers: {'Set-Cookie': cookie.makeHeaderValue()},
        body: JSON.stringify({
            authenticationResult: {
                accessToken: session.accessToken,
                idToken: session.idToken,
                profile: jwtDecode(session.idToken)
            },
            challengeParameters: {}
        })
    }
}



