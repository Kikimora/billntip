import {
    CognitoIdentityProvider,
    UnauthorizedException
} from "@aws-sdk/client-cognito-identity-provider";
import * as process from "process";
import _ from "@app/util";
import {createHmac} from "crypto";
import {HttpError, Middleware, pipeline, requireLambdaAuth, TracedEvent, Request} from "@app/lambda";
import Paths from "./paths";
import * as Schemas from "./schemas";
import SessionData, {SessionContext} from "@src/authorizer/session";
import {userPoolDetails} from "@src/cognito";
import {configure, withErrorContext} from "@app/diagnostics";
import OidcTokens from "@src/authorizer/oidc_tokens";
import {jwtDecode} from "jwt-decode";
import {
    InitiateAuthResponse,
    RespondToAuthChallengeResponse
} from "@aws-sdk/client-cognito-identity-provider/dist-types/models/models_0";
import {initModuleVariables} from "@src/authorizer/ctx";
import {Static} from "@sinclair/typebox";

const ClientId = process.env.OAUTH_CLIENT_ID ?? _.throw("Missing required OAUTH_CLIENT_ID env variable")
const UserPoolId = process.env.USER_POOL_ID ?? _.throw("Missing required USER_POOL_ID env variable")
const cognito = new CognitoIdentityProvider()

/**
 * Static initialisation loads user pool details.
 */
export async function __init() {
    const {ClientSecret} = await userPoolDetails(UserPoolId, ClientId)
    if (ClientSecret === undefined)
        throw new Error("Cannot load UserPool client secret.")
    return {ClientSecret}
}

declare module "@aws-sdk/client-cognito-identity-provider" {
    interface UnauthorizedException extends HttpError {

    }
}
Object.defineProperty(UnauthorizedException.prototype, 'statusCode', {
    value: 401, writable: false
})

configure({triggers: {request: true}})

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .withRoutes(Paths)
    .parseJsonBody()
    .do(async function (this: Middleware, e: TracedEvent, ctx: any) {
        const response = await this.next(e, ctx)
        //cleanup AWS noise
        delete response.$metadata
        return toCamel(response)
    })
    .done(async function (req) {
        switch (req.routeKey) {
            case "GET /user/session":
                requireLambdaAuth<SessionContext>(req)
                const session = req.requestContext.authorizer.lambda;
                return {
                    accessToken: session.access_token,
                    idToken: session.id_token,
                    profile: session.profile,
                    expiresAt: session.expires_at
                } satisfies Static<typeof Schemas.GetSessionResponse>
            case "POST /user": {
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                return await cognito.signUp({
                    Username: body.username,
                    Password: body.password,
                    UserAttributes: body.userAttributes?.map(x => ({Name: x.name, Value: x.value})),
                    ClientMetadata: body.clientMetadata,
                    ValidationData: body.userAttributes?.map(x => ({Name: x.name, Value: x.value})),
                    ClientId,
                    SecretHash: secretHash(body.username, ClientSecret),
                })
            }
            case "POST /user/confirm": {
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                return await cognito.confirmSignUp({
                    Username: body.username,
                    ConfirmationCode: body.confirmationCode,
                    ClientMetadata: body.clientMetadata,
                    ClientId,
                    SecretHash: secretHash(body.username, ClientSecret)
                })
            }
            case "PUT /user": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.requestContext.authorizer.lambda;

                //validate attributes
                //add or remove user from a recipients group
                //refresh tokens
                const {body} = req.parse()
                return await cognito.updateUserAttributes({
                    UserAttributes: body.userAttributes?.map(x => ({Name: x.name, Value: x.value})),
                    ClientMetadata: body.clientMetadata,
                    AccessToken: session.access_token,
                })
            }
            case "POST /user/resend_confirmation_code": {
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                return await cognito.resendConfirmationCode({
                    Username: body.username,
                    ClientMetadata: body.clientMetadata,
                    ClientId,
                    SecretHash: secretHash(body.username, ClientSecret)
                })
            }
            case "POST /user/signin": {
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                const auth = await cognito.initiateAuth({
                    AuthFlow: body.authFlow,
                    ClientMetadata: body.clientMetadata,
                    AuthParameters: {
                        "SECRET_HASH": secretHash(body.authParameters['USERNAME'], ClientSecret),
                        ...body.authParameters
                    },
                    ClientId,
                })
                return await processAuthResponse(req, auth);
            }
            case "POST /user/signin/challenge": {
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                const auth = await cognito.respondToAuthChallenge({
                    Session: body.session,
                    ChallengeName: body.challengeName,
                    ChallengeResponses: {
                        "SECRET_HASH": secretHash(body.challengeResponses['USERNAME'], ClientSecret),
                        ...body.challengeResponses
                    },
                    ClientMetadata: body.clientMetadata,
                    ClientId,
                })
                return await processAuthResponse(req, auth);
            }
            case "POST /user/signout": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.requestContext.authorizer.lambda;

                return await cognito.globalSignOut({
                    AccessToken: session.access_token
                })
            }
            case "POST /user/password": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.requestContext.authorizer.lambda;

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
                return await cognito.forgotPassword({
                    ClientMetadata: body.clientMetadata,
                    Username: body.username,
                    ClientId,
                    SecretHash: secretHash(body.username, ClientSecret)
                })
            }
            case "POST /user/password/confirm": {
                const {ClientSecret} = await __init()
                const {body} = req.parse()
                return await cognito.confirmForgotPassword({
                    Username: body.username,
                    ClientMetadata: body.clientMetadata,
                    Password: body.password,
                    ConfirmationCode: body.confirmationCode,
                    ClientId,
                    SecretHash: secretHash(body.username, ClientSecret),
                })
            }
            case "GET /user/devices": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.requestContext.authorizer.lambda;

                const {body} = req.parse()
                return await cognito.listDevices({
                    Limit: body.limit,
                    PaginationToken: body.paginationToken,
                    AccessToken: session.access_token,
                })
            }
            case "GET /user/device/{id}": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.requestContext.authorizer.lambda;

                return await cognito.getDevice({
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: session.access_token,
                })
            }
            case "PUT /user/device/{id}/confirm": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.requestContext.authorizer.lambda;

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
                const session = req.requestContext.authorizer.lambda;

                return await cognito.forgetDevice({
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: session.access_token,
                })
            }
            case "PUT /user/device/{id}": {
                requireLambdaAuth<SessionContext>(req)
                const session = req.requestContext.authorizer.lambda;

                const {body} = req.parse()
                return await cognito.updateDeviceStatus({
                    DeviceKey: req.pathParameters?.['id'],
                    DeviceRememberedStatus: body.deviceRememberedStatus,
                    AccessToken: session.access_token,
                })
            }
        }
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

async function processAuthResponse(req: Request & TracedEvent, auth: InitiateAuthResponse | RespondToAuthChallengeResponse) {
    if (auth.AuthenticationResult !== undefined) {
        const {AccessToken, IdToken, RefreshToken, ExpiresIn} = auth.AuthenticationResult
        if (AccessToken === undefined || IdToken === undefined ||
            RefreshToken === undefined || ExpiresIn === undefined) {
            throw withErrorContext(
                new Error("Unexpected OIDC provider response"),
                "POST /user/signin",
                {
                    cognitoResponse: auth.AuthenticationResult
                })
        }

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
    } else {
        return auth
    }
}
