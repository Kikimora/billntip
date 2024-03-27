import {
    CognitoIdentityProvider,
    UnauthorizedException
} from "@aws-sdk/client-cognito-identity-provider";
import * as process from "process";
import _ from "lodash";
import {
    isLambdaAuthorizedRequest,
    Middleware,
    pipeline,
    Request,
} from "@app/lambda";
import Routes from "./routes";
import {createHmac} from "crypto";
import {SessionContext} from "@src/authorizer/session";

const ClientId = process.env.OAUTH_CLIENT_ID ?? _.throw("Missing required OAUTH_CLIENT_ID env variable")
const ClientSecret = process.env.OAUTH_CLIENT_SECRET ?? _.throw("Missing required OAUTH_CLIENT_SECRET env variable")
const cognito = new CognitoIdentityProvider()

export const handler = pipeline()
    .do(async function (this: Middleware, e: any, ctx: any) {
        try {
            return await this.next(e, ctx)
        } catch (e: any) {
            if ('name' in e && e.name == "UnauthorizedException") {
                return {statusCode: 401}
            }
            return {statusCode: 500}
        }
    })
    .traceRequest()
    .withRoutes(Routes)
    .parseJsonBody()
    .do(async function (this: Middleware, e: any, ctx: any) {
        const response = await this.next(e, ctx)
        return toCamel(response)
    })
    .done(async function (req) {
        switch (req.routeKey) {
            case "GET /user/session":
                const session = userSession(req);
                return {
                    accessToken: session.access_token,
                    idToken: session.id_token,
                    profile: session.profile,
                    expiresAt: session.expires_at
                }
            case "POST /user": {
                const {body} = req.parse()
                return await cognito.signUp({
                    Username: body.username,
                    Password: body.password,
                    UserAttributes: body.userAttributes?.map(x => ({Name: x.name, Value: x.value})),
                    ClientMetadata: body.clientMetadata,
                    ValidationData: body.userAttributes?.map(x => ({Name: x.name, Value: x.value})),
                    ClientId,
                    SecretHash: secretHash(body.username),
                })
            }
            case "POST /user/confirm": {
                const {body} = req.parse()
                return await cognito.confirmSignUp({
                    Username: body.username,
                    ConfirmationCode: body.confirmationCode,
                    ClientMetadata: body.clientMetadata,
                    ClientId,
                    SecretHash: secretHash(body.username)
                })
            }
            case "PUT /user": {
                //validate attributes
                //add or remove user from a recipients group
                //refresh tokens
                const {body} = req.parse()
                return await cognito.updateUserAttributes({
                    UserAttributes: body.userAttributes?.map(x => ({Name: x.name, Value: x.value})),
                    ClientMetadata: body.clientMetadata,
                    AccessToken: userSession(req).access_token,
                })
            }
            case "POST /user/resend_confirmation_code": {
                const {body} = req.parse()
                return await cognito.resendConfirmationCode({
                    Username: body.username,
                    ClientMetadata: body.clientMetadata,
                    ClientId,
                    SecretHash: secretHash(body.username)
                })
            }
            case "POST /user/signin": {
                const {body} = req.parse()
                return await cognito.initiateAuth({
                    AuthFlow: body.authFlow,
                    ClientMetadata: body.clientMetadata,
                    AuthParameters: {
                        "SECRET_HASH": "",
                        ...body.authParameters
                    },
                    ClientId,
                })
            }
            case "POST /user/signin/challenge": {
                const {body} = req.parse()
                return await cognito.respondToAuthChallenge({
                    Session: body.session,
                    ChallengeName: body.challengeName,
                    ChallengeResponses: body.challengeResponses,
                    ClientMetadata: body.clientMetadata,
                    ClientId,
                })
            }
            case "POST /user/signout": {
                return await cognito.globalSignOut({
                    AccessToken: userSession(req).access_token
                })
            }
            case "POST /user/password": {
                const {body} = req.parse()
                return await cognito.changePassword({
                    PreviousPassword: body.previousPassword,
                    ProposedPassword: body.proposedPassword,
                    AccessToken: userSession(req).access_token,
                })
            }
            case "POST /user/password/forgot": {
                const {body} = req.parse()
                return await cognito.forgotPassword({
                    ClientMetadata: body.clientMetadata,
                    Username: body.username,
                    ClientId,
                    SecretHash: secretHash(body.username)
                })
            }
            case "POST /user/password/confirm": {
                const {body} = req.parse()
                return await cognito.confirmForgotPassword({
                    Username: body.username,
                    ClientMetadata: body.clientMetadata,
                    Password: body.password,
                    ConfirmationCode: body.confirmationCode,
                    ClientId,
                    SecretHash: secretHash(body.username),
                })
            }
            case "GET /user/devices": {
                const {body} = req.parse()
                return await cognito.listDevices({
                    Limit: body.limit,
                    PaginationToken: body.paginationToken,
                    AccessToken: userSession(req).access_token,
                })
            }
            case "GET /user/device/{id}": {
                return await cognito.getDevice({
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: userSession(req).access_token,
                })
            }
            case "PUT /user/device/{id}/confirm": {
                const {body} = req.parse()
                return await cognito.confirmDevice({
                    DeviceName: body.deviceName,
                    DeviceSecretVerifierConfig: {
                        Salt: body.deviceSecretVerifierConfig?.salt,
                        PasswordVerifier: body.deviceSecretVerifierConfig?.passwordVerifier,
                    },
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: userSession(req).access_token,
                })
            }
            case "DELETE /user/device/{id}": {
                return await cognito.forgetDevice({
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: userSession(req).access_token,
                })
            }
            case "PUT /user/device/{id}": {
                const {body} = req.parse()
                return await cognito.updateDeviceStatus({
                    DeviceKey: req.pathParameters?.['id'],
                    DeviceRememberedStatus: body.deviceRememberedStatus,
                    AccessToken: userSession(req).access_token,
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

function userSession(e: Request): SessionContext {
    if (!isLambdaAuthorizedRequest<SessionContext>(e)) {
        throw new UnauthorizedException({
            message: "Unauthorized",
            $metadata: {}
        })
    }
    return e.requestContext.authorizer.lambda
}

function secretHash(username: string) {
    const hasher = createHmac('sha256', ClientSecret);
    hasher.update(`${username}${ClientId}`);
    return hasher.digest('base64');
}