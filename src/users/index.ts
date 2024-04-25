import {
    CognitoIdentityProvider,
    InitiateAuthResponse,
    RespondToAuthChallengeResponse,
    UnauthorizedException
} from "@aws-sdk/client-cognito-identity-provider";
import * as process from "process";
import {createHmac} from "crypto";
import _ from "@app/util";
import {
    HttpError,
    internalServerError,
    LambdaRequest,
    Middleware,
    pipeline,
    requireLambdaAuth,
    TracedEvent
} from "@app/lambda";
import Paths from "./paths";
import * as Schemas from "./schemas";
import SessionData, {SessionContext} from "@src/authorizer/session";
import {userPoolClientDetails} from "@src/cognito";
import {configure} from "@app/diagnostics";
import OidcTokens from "@src/authorizer/oidc_tokens";
import {jwtDecode} from "jwt-decode";
import {initModuleVariables} from "@src/authorizer/ctx";
import {Static} from "@sinclair/typebox";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import UserRepo from "./user"

const ClientId = process.env.OAUTH_CLIENT_ID ?? _.throw("Missing required OAUTH_CLIENT_ID env variable")
const UserPoolId = process.env.USER_POOL_ID ?? _.throw("Missing required USER_POOL_ID env variable")

/**
 * Static initialisation loads user pool details.
 */
export async function __init() {
    const {ClientSecret} = await userPoolClientDetails(UserPoolId, ClientId, cognito)
    if (ClientSecret === undefined)
        throw new Error("Cannot load UserPool client secret.")
    return {ClientSecret}
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
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                const {USERNAME: uid} = body.authParameters
                const userRepo = new UserRepo(req, dynamo)
                const user = await userRepo.fetchLocked(uid)

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
                    return await processAuthResponse(req, auth);
                } finally {
                    await user.unlock()
                }
            }
            case "POST /user/signin/challenge": {
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                const {USERNAME: uid} = body.challengeResponses
                const userRepo = new UserRepo(req, dynamo)
                const user = await userRepo.fetchLocked(uid)
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
                    return await processAuthResponse(req, auth);
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
                try {
                    const session = await SessionData.fetch(req.user.id)
                    if (session === null) throw new Error("Cannot find user session")
                    return await createNewSession(session.refreshToken,
                        session.idToken,
                        session.accessToken,
                        session.accessExpiresAt,
                        req)
                } catch (e: any) {
                    throw internalServerError(e.message)
                }
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
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                const userDataRepo = new UserRepo(req, dynamo)
                const user = await userDataRepo.createLocked(body.username, 'user', body.userAttributes)
                try {
                    const aliases = body.userAttributes?.filter(x => userDataRepo.isAliasAttribute(x))
                    return await cognito.signUp({
                        Username: user.username,
                        Password: body.password,
                        UserAttributes: aliases?.map(x => ({Name: x.name, Value: x.value})),
                        ClientMetadata: body.clientMetadata,
                        ValidationData: body.validationData?.map(x => ({Name: x.name, Value: x.value})),
                        ClientId,
                        SecretHash: secretHash(user.username, ClientSecret)
                    })
                } finally {
                    await user.unlock()
                }
            }
            case "POST /user/confirm": {
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                const userDataRepo = new UserRepo(req, dynamo)
                const user = await userDataRepo.fetchLocked(body.username)
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
                    const aliasAttributes = userRepo.aliases(body.userAttributes)
                    if (aliasAttributes.length > 0) {
                        const response = await cognito.updateUserAttributes({
                            UserAttributes: aliasAttributes.map(x => ({Name: x.name, Value: x.value})),
                            ClientMetadata: body.clientMetadata,
                            AccessToken: req.user.access_token,
                        })
                        codeDeliveryDetailsList = response.CodeDeliveryDetailsList
                    }
                    const normalAttributes = userRepo.normalAttributes(body.userAttributes)
                    const cognitoAttributes = await fetchCognitoAttributes(user.username)
                    const attrs = _(normalAttributes).concat(cognitoAttributes).keyBy('name').map().value()
                    await user.updateAttributes('trusted', attrs)
                    return {
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
    })

function renameProperties(o: any, makeNewName: (oldName: string) => string) {
    let newO: any, origKey, newKey, value
    if (o instanceof Array) {
        return o.map(function (value) {
            if (typeof value === "object") {
                value = renameProperties(value, makeNewName)
            }
            return value
        })
    } else {
        newO = {}
        for (origKey in o) {
            if (o.hasOwnProperty(origKey)) {
                newKey = makeNewName(origKey)
                value = o[origKey]
                if (value instanceof Array || (value !== null && value.constructor === Object)) {
                    value = renameProperties(value, makeNewName)
                }
                newO[newKey] = value
            }
        }
    }
    return newO
}

function toCamel(o: any) {
    return renameProperties(o, origKey => (origKey.charAt(0).toLowerCase() + origKey.slice(1) || origKey).toString())
}

function toPascal(o: any) {
    return renameProperties(o, origKey => (origKey.charAt(0).toUpperCase() + origKey.slice(1) || origKey).toString())
}

function secretHash(username: string, clientSecret: string) {
    const hasher = createHmac('sha256', clientSecret);
    hasher.update(`${username}${ClientId}`);
    return hasher.digest('base64');
}

async function createNewSession(RefreshToken: string, IdToken: string, AccessToken: string, ExpiresIn: number, req: LambdaRequest<unknown> & TracedEvent) {
    await initModuleVariables()
    const tokens = new OidcTokens(RefreshToken, IdToken, AccessToken, ExpiresIn)
    const session = SessionData.createWithTokens(tokens)
    const cookie = session.makeCookie()
    await session.create()
    req.tracer.info("new session", {
        sessionId: session.sessionId,
        refreshBefore: session.accessExpiresAt,
        expiresAt: session.refreshTokenExpiresAt
    })
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

async function processAuthResponse(req: LambdaRequest & TracedEvent, auth: InitiateAuthResponse | RespondToAuthChallengeResponse) {
    if (auth.AuthenticationResult !== undefined) {
        const {AccessToken, IdToken, RefreshToken, ExpiresIn} = auth.AuthenticationResult
        if (AccessToken === undefined || IdToken === undefined ||
            RefreshToken === undefined || ExpiresIn === undefined) {
            throw internalServerError("Unexpected OIDC provider response").withContext("processAuthResponse", {
                cognitoResponse: auth.AuthenticationResult
            })
        }
        return await createNewSession(RefreshToken, IdToken, AccessToken, ExpiresIn, req);
    } else {
        return auth
    }
}

async function fetchCognitoAttributes(username: string) {
    const cognitoUser = await cognito.adminGetUser({Username: username, UserPoolId})
    const attributes = cognitoUser.UserAttributes;
    const verifiers = _(attributes)
        .filter(x => x.Name?.endsWith('_verified') ?? false)
        .keyBy('Name')
        .mapKeys((_1, k) => k.substring(0, k.length - 9 /*_verified.length*/))
        .mapValues('Value')
        .value()
    return _(attributes)
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
        .value();
}