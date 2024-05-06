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
    internalServerError, LambdaRequest,
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
import UserRepo, {UserAttribute} from "./user"
import {toUserAttributes} from "./cognito"
import SessionCookie from "@src/authorizer/cookie";

const ClientId = process.env.OAUTH_CLIENT_ID ?? _.throw("Missing required OAUTH_CLIENT_ID env variable")
export const UserPoolId = process.env.USER_POOL_ID ?? _.throw("Missing required USER_POOL_ID env variable")

const cognito = new CognitoIdentityProvider()

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
                const userRepo = createUserRepo(req)
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
                const userRepo = createUserRepo(req)
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
                return refreshSessionResponse(newSession)
            }
            case "DELETE /user/session": {
                requireLambdaAuth<SessionContext>(req)
                const user = req.user;
                await cognito.globalSignOut({
                    AccessToken: user.access_token
                })
                await initModuleVariables()
                const session = await SessionData.fetch(req.user.id)
                if (session !== null) {
                    await session.remove()
                }
                const cookie = new SessionCookie(user.id, new Date(0))
                return {
                    statusCode: 200,
                    headers: {'Set-Cookie': cookie.makeHeaderValue()},
                }
            }
//#endregion
//#region SignUp
            case "POST /user": {
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                const userDataRepo = createUserRepo(req)
                const attributes = body.userAttributes ?? [];
                const aliases = userDataRepo.aliases(attributes)
                const normalAttributes = userDataRepo.normalAttributes(attributes)
                const metadata = {
                    ...body.clientMetadata,
                    '_attributes': JSON.stringify(normalAttributes)
                }
                //Cognito trigger create user in dynamodb using
                return await cognito.signUp({
                    Username: body.username,
                    Password: body.password,
                    UserAttributes: aliases?.map(x => ({Name: x.name, Value: x.value})),
                    ClientMetadata: metadata,
                    ValidationData: body.validationData?.map(x => ({Name: x.name, Value: x.value})),
                    ClientId,
                    SecretHash: secretHash(body.username, ClientSecret)
                })
            }
            case "POST /user/confirm": {
                const {ClientSecret, UsernameAttributes} = await __init()
                const {body} = req.parse()
                const userDataRepo = createUserRepo(req)
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
                const repo = createUserRepo(req)
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
                const userRepo = createUserRepo(req)
                const user = await userRepo.fetch(username)
                return user.attributes satisfies Readonly<Static<typeof req.route.success>>
            }
            case "PUT /user/attributes": {
                requireLambdaAuth<SessionContext>(req)
                const {body} = req.parse()
                const username = req.user.profile['cognito:username']
                let codeDeliveryDetailsList

                const userRepo = createUserRepo(req)
                const user = await userRepo.fetchLocked(username)
                try {
                    const bodyAttributes = body.userAttributes
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
                const userRepo = createUserRepo(req)
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
                const userRepo = createUserRepo(req)
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
                const userRepo = createUserRepo(req)
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

        async function createNewSession(RefreshToken: string, IdToken: string, AccessToken: string, ExpiresIn: number) {
            await initModuleVariables()
            const tokens = new OidcTokens(RefreshToken, IdToken, AccessToken, ExpiresIn)
            const session = SessionData.createWithTokens(tokens)
            await session.create()
            return refreshSessionResponse(session);
        }

        function refreshSessionResponse(session: SessionData) {
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
    })


function secretHash(username: string, clientSecret: string) {
    const hasher = createHmac('sha256', clientSecret);
    hasher.update(`${username}${ClientId}`);
    return hasher.digest('base64');
}


function createUserRepo(req: LambdaRequest & TracedEvent) {
    return new UserRepo({
        tag: req.requestContext.requestId,
        db: dynamo,
        tracer: req.tracer
    });
}

async function fetchCognitoAttributes(username: string): Promise<UserAttribute[]> {
    const cognitoUser = await cognito.adminGetUser({Username: username, UserPoolId})
    return toUserAttributes(cognitoUser.UserAttributes);
}



