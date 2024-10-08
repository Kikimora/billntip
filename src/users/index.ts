import * as Cognito from "@aws-sdk/client-cognito-identity-provider";
import {createHmac} from "crypto";
import {jwtDecode} from "jwt-decode";
import {Static, Type} from "@sinclair/typebox";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import _, {die} from "@app/util";
import {
    badRequestError,
    internalError,
    pipeline,
    requireLambdaAuth,
    bootstrap, notFoundError
} from "@app/lambda";
import diagnostics from "@app/diagnostics";
import startAuthOperation, {SessionData, AuthOptionsSchema, SessionContextCheck} from "@src/authorizer/operation";
import Paths from "./paths";
import * as Schemas from "./schemas";
import UserRepo, {invalidAliasException, UserAttribute} from "./user"
import {toUserAttributes} from "./cognito"
import {CodeDeliveryDetails, Device, DeviceAttribute} from "./schemas";
import {uploadBuilder} from "@src/object-store";

const cognito = new Cognito.CognitoIdentityProvider()
const dynamo = new DynamoDB()
const Module = bootstrap()
    .parameters(AuthOptionsSchema)
    .parameters({dynamodb: Type.Object({users: Type.String()})})
    .parameters({'users-diagnostics': diagnostics.OptionsSchema})
    .parameters({'s3': Type.Object({bucket: Type.String(), tmpPrefix: Type.String()})})
    .buildModule(async function (options) {
        const {dynamodb, oidc, api, 'users-diagnostics': diagnosticsConfig, s3} = options
        diagnostics(diagnosticsConfig)

        const [{UserPoolClient}, {UserPool}] = await Promise.all([
            cognito.describeUserPoolClient({UserPoolId: oidc.userPoolId, ClientId: api.clientId}),
            cognito.describeUserPool({UserPoolId: oidc.userPoolId})
        ])
        const clientSecret = UserPoolClient?.ClientSecret ?? die("Cannot load UserPool client secret.")
        const usernameAttributes = UserPool?.UsernameAttributes ?? []

        const userRepo = new UserRepo({
            db: dynamo,
            table: dynamodb.users,
            locks: dynamodb.locks
        })

        return {
            s3,
            dynamodb: dynamo,
            ClientSecret: clientSecret,
            UserPoolId: oidc.userPoolId,
            ClientId: api.clientId,
            UsernameAttributes: usernameAttributes,
            userRepo,
            options,
            cognito
        }
    })

/**
 * Static initialisation.
 */
export function __init() {
    return Module.exports
}

Object.defineProperty(Cognito.UnauthorizedException.prototype, 'statusCode', {
    value: '401', writable: false
})

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .withRoutes(Paths)
    .parseJsonBody()
    .done(async function (req) {
        const {ClientSecret, UserPoolId, ClientId, UsernameAttributes, userRepo, options, s3} = await __init()
        switch (req.routeKey) {
//#region Session
            case "POST /user/signin": {
                const {body} = req.parse()
                const {USERNAME: usernameOrAlias} = body.authParameters
                const poolUseUsernameAttributes = (UsernameAttributes.length ?? 0) > 0;
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
                            "SECRET_HASH": secretHash(user.username, ClientSecret, ClientId),
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
                const {body} = req.parse()
                const {USERNAME: usernameOrAlias} = body.challengeResponses
                const poolUseUsernameAttributes = (UsernameAttributes.length ?? 0) > 0;
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
                            "SECRET_HASH": secretHash(user.username, ClientSecret, ClientId),
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
                requireLambdaAuth(req, SessionContextCheck)
                const session = req.principal;
                /*
                This endpoint returns cached session. For this reason `POST /user/session` handler creates new session cookie
                with a slightly different identifier to bypass cache and force this endpoint return the most recent
                information.
                 */
                return {
                    accessToken: session.access_token,
                    idToken: session.id_token,
                    profile: session.id_token_json,
                    expiresAt: session.access_token_expires_at
                } satisfies Static<typeof Schemas.GetSessionResponse>
            }
            case 'POST /user/session': {
                requireLambdaAuth(req, SessionContextCheck)
                const {sessions, tokens: oidc} = await startAuthOperation(req.requestContext.requestId, options)
                const session = await sessions.fetch(req.principal.id)
                if (session === null) throw new Error("Cannot find user session")

                const tokens = await oidc.refresh(session.refreshToken)
                if (tokens === null) throw badRequestError("Cannot refresh session.")
                const newSession = await session.updateTokens(tokens).applyUpdates().save()
                return refreshSessionResponse(newSession)
            }
            case "DELETE /user/session": {
                requireLambdaAuth(req, SessionContextCheck)
                const principal = req.principal;
                await cognito.globalSignOut({
                    AccessToken: principal.access_token
                })
                const {sessions, cookies} = await startAuthOperation(req.requestContext.requestId, options)
                const session = await sessions.fetch(req.principal.id)
                if (session !== null) {
                    await session.remove()
                }
                const cookie = cookies.create(principal.id, new Date(0))
                return {
                    statusCode: 200,
                    headers: {'Set-Cookie': cookie.makeHeaderValue()},
                }
            }
//#endregion
//#region SignUp
            case "POST /user": {
                const {body} = req.parse()
                type Response = Static<typeof req.route.success>

                async function signUp(username: string): Promise<Response> {
                    const attributes = body.userAttributes ?? [];
                    const aliases = userRepo.aliases(attributes)
                    const metadata = {
                        ...body.clientMetadata,
                        _attributes: JSON.stringify(userRepo.normalAttributes(attributes))
                    }
                    const response = await cognito.signUp({
                        Username: username,
                        Password: body.password,
                        UserAttributes: aliases?.map(x => ({Name: x.name, Value: x.value})),
                        ClientMetadata: metadata,
                        ValidationData: body.validationData?.map(x => ({Name: x.name, Value: x.value})),
                        ClientId,
                        SecretHash: secretHash(username, ClientSecret, ClientId)
                    })

                    return {
                        codeDeliveryDetails: toCodeDeliveryDetails(response.CodeDeliveryDetails),
                        userConfirmed: response.UserConfirmed,
                        userSub: response.UserSub
                    }
                }

                const poolUseUsernameAttributes = (UsernameAttributes.length ?? 0) > 0;
                if (poolUseUsernameAttributes) {
                    /**
                     * When User Pool use 'username attributes' it
                     * 1. accept username and put it into either email or phone_number
                     * 2. generates username.
                     * 3. allows duplicate alias attributes in users until they are not used as a username
                     * 4. allows change of the username attribute value
                     *
                     * Duplication happens in the following scenario
                     * 1. Create Username = email1@example.com, phone=+123 - OK (Username=GUID, Email=email1@example.com, phone=+123)
                     * 2. Create Username = email2@example.com, phone=+123 - OK (Username=GUID, Email=email2@example.com, phone=+123)
                     *
                     * This is a problem for multiple reasons
                     * 1. We need to know username (the GUID) before creating a user (which we don't).
                     * 2. We want to create user in DynamoDB before interacting with cognito to guarantee alias uniqueness.
                     * 3. Duplication is an issue because user can attempt change Username from email to phone number which is duplicated.
                     * 4. Duplication is also an issue because it does not fit into DynamoDB schema.
                     *
                     * Solution:
                     * 1. SignUp user first to get user id. Cognito guarantee username attribute uniqueness.
                     * 2. Do not allow alias attributes to guarantee cognito does not create duplicates. Just don't ise use cognito with username attributes if you need otherwise.
                     * 3. Read cognito right after signup and create aliases in Dynamo.
                     *
                     * We are guaranteed to read just one alias from Cognito. Resulting DB state is
                     * 1. Username guid which is different from any alias attribute.
                     * 2. Username attribute mapping to the username guid.
                     * 3. No other alias attributes.
                     */

                    const aliases = userRepo.aliases(body.userAttributes ?? [])
                    if (aliases.length > 0) {
                        throw invalidAliasException().withContext("createUser", {
                            details: "Cannot create alias attributes (email, phone_number) with a user pool configured to use username attributes."
                        })
                    }

                    const response = await signUp(body.username)
                    const userId = response.userSub
                    if (userId === undefined)
                        throw internalError("Unexpected error - Cognito didn't generate user id")
                    const cognitoAliases = await fetchCognitoAttributes(userId, UserPoolId)
                    const attributes = userRepo.normalAttributes(body.userAttributes ?? [])
                    await userRepo.create(userId, 'trusted', attributes.concat(cognitoAliases))
                    return response satisfies Static<typeof req.route.success>
                } else {
                    /**
                     * In this mode username cannot be equal to any of alias attributes which is guaranteed by the user repo.
                     */
                    await userRepo.create(body.username, 'user', body.userAttributes)
                    return await signUp(body.username) satisfies Static<typeof req.route.success>
                }
            }
            case "POST /user/confirm": {
                const {body} = req.parse()
                const poolUseUsernameAttributes = (UsernameAttributes.length ?? 0) > 0;
                const user = await userRepo.fetchLocked(body.username, {
                    allowUnverifiedAlias: poolUseUsernameAttributes
                })
                try {
                    await cognito.confirmSignUp({
                        Username: user.username,
                        ConfirmationCode: body.confirmationCode,
                        ClientMetadata: body.clientMetadata,
                        ClientId,
                        SecretHash: secretHash(user.username, ClientSecret, ClientId)
                    })
                    const cognitoAttributes = await fetchCognitoAttributes(body.username, UserPoolId);
                    await user.updateAttributes('trusted', cognitoAttributes)
                    return {} satisfies Static<typeof req.route.success>
                } finally {
                    await user.unlock()
                }
            }
            case "POST /user/resend_confirmation_code": {
                const {body} = req.parse()
                const {username} = await userRepo.lookupAlias(body.username)
                const response = await cognito.resendConfirmationCode({
                    Username: username,
                    ClientMetadata: body.clientMetadata,
                    ClientId,
                    SecretHash: secretHash(username, ClientSecret, ClientId)
                })
                return {
                    codeDeliveryDetails: toCodeDeliveryDetails(response.CodeDeliveryDetails)
                } satisfies Static<typeof req.route.success>
            }
//#endregion
//#region Attributes
            case 'GET /user/attributes': {
                requireLambdaAuth(req, SessionContextCheck)
                const username = req.principal.id_token_json['cognito:username']
                const user = await userRepo.fetch(username)
                return user.attributes satisfies Static<typeof req.route.success>
            }
            case 'POST /user/image': {
                requireLambdaAuth(req, SessionContextCheck)
                const upload = uploadBuilder(`images/users/${req.principal.id}.png`, {
                    bucket: s3.bucket,
                    prefix: s3.tmpPrefix
                })
                    .condition(["content-length-range", 1024, 5 * 1024 * 1024])
                    .condition(["starts-with", "$Content-Type", "image/"])
                    .properties({
                        'transform': 'resize',
                        'target-width': '100',
                        'target-height': '100',
                        'target-format': 'png'
                    })
                return await upload.build() satisfies Static<typeof req.route.success>
            }
            case "PUT /user/attributes": {
                requireLambdaAuth(req, SessionContextCheck)
                const {body} = req.parse()
                const username = req.principal.id_token_json['cognito:username']
                let codeDeliveryDetailsList: CodeDeliveryDetails[] | undefined

                const user = await userRepo.fetchLocked(username)
                try {
                    const bodyAttributes = body.userAttributes
                    const aliasAttributes = userRepo.aliases(bodyAttributes)
                    req.tracer.info("Update Cognito attributes", {attributes: aliasAttributes})
                    if (aliasAttributes.length > 0) {
                        const response = await cognito.updateUserAttributes({
                            UserAttributes: aliasAttributes.map(x => ({Name: x.name, Value: x.value})),
                            ClientMetadata: body.clientMetadata,
                            AccessToken: req.principal.access_token,
                        })
                        if (response.CodeDeliveryDetailsList !== undefined) {
                            codeDeliveryDetailsList = response.CodeDeliveryDetailsList
                                .map(toCodeDeliveryDetails)
                                .filter(function (code): code is CodeDeliveryDetails {
                                    return code !== undefined
                                })
                        }
                    }
                    const normalAttributes = userRepo.normalAttributes(bodyAttributes)
                    const cognitoAttributes = await fetchCognitoAttributes(user.username, UserPoolId)
                    const attrs = _(normalAttributes).concat(cognitoAttributes).keyBy('name').map().value()
                    await user.updateAttributes('trusted', attrs)
                    return {
                        attributes: user.attributes,
                        codeDeliveryDetailsList
                    } satisfies Static<typeof req.route.success>
                } finally {
                    await user.unlock()
                }
            }
            case 'DELETE /user/attributes': {
                requireLambdaAuth(req, SessionContextCheck)
                const {body} = req.parse()
                const username = req.principal.id_token_json['cognito:username']
                const user = await userRepo.fetchLocked(username)
                try {
                    const aliasAttributes = userRepo.aliases(body.userAttributesNames)
                    if (aliasAttributes.length > 0) {
                        await cognito.deleteUserAttributes({
                            UserAttributeNames: body.userAttributesNames,
                            AccessToken: req.principal.access_token
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
                requireLambdaAuth(req, SessionContextCheck)
                const session = req.principal;

                const {body} = req.parse()
                return await cognito.changePassword({
                    PreviousPassword: body.previousPassword,
                    ProposedPassword: body.proposedPassword,
                    AccessToken: session.access_token,
                })
            }
            case "POST /user/password/forgot": {
                const {body} = req.parse()
                const {username} = await userRepo.lookupAlias(body.username)
                const response = await cognito.forgotPassword({
                    ClientMetadata: body.clientMetadata,
                    Username: username,
                    ClientId,
                    SecretHash: secretHash(username, ClientSecret, ClientId)
                })
                return {
                    codeDeliveryDetails: toCodeDeliveryDetails(response.CodeDeliveryDetails)
                } satisfies Static<typeof req.route.success>
            }
            case "POST /user/password/confirm": {
                const {body} = req.parse()
                const {username} = await userRepo.lookupAlias(body.username)
                const response = await cognito.confirmForgotPassword({
                    Username: username,
                    ClientMetadata: body.clientMetadata,
                    Password: body.password,
                    ConfirmationCode: body.confirmationCode,
                    ClientId,
                    SecretHash: secretHash(username, ClientSecret, ClientId),
                })
                return response satisfies Static<typeof req.route.success>
            }
//#endregion
//#region Devices
            case "GET /user/devices": {
                requireLambdaAuth(req, SessionContextCheck)
                const session = req.principal;
                const {body} = req.parse()
                const response = await cognito.listDevices({
                    Limit: body.limit,
                    PaginationToken: body.paginationToken,
                    AccessToken: session.access_token,
                })
                return {
                    devices: (response.Devices ?? [])
                        .map(toDevice)
                        .filter(function (device): device is Device {
                            return device !== undefined
                        }),
                    paginationToken: response.PaginationToken
                } satisfies Static<typeof req.route.success>
            }
            case "GET /user/device/{id}": {
                requireLambdaAuth(req, SessionContextCheck)
                const session = req.principal;
                const response = await cognito.getDevice({
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: session.access_token,
                })
                const device = toDevice(response.Device)
                if (device == undefined) throw notFoundError()
                return {device}  satisfies Static<typeof req.route.success>
            }
            case "PUT /user/device/{id}/confirm": {
                requireLambdaAuth(req, SessionContextCheck)
                const session = req.principal;

                const {body} = req.parse()
                const response = await cognito.confirmDevice({
                    DeviceName: body.deviceName,
                    DeviceSecretVerifierConfig: {
                        Salt: body.deviceSecretVerifierConfig?.salt,
                        PasswordVerifier: body.deviceSecretVerifierConfig?.passwordVerifier,
                    },
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: session.access_token,
                })

                return {
                    userConfirmationNecessary: response.UserConfirmationNecessary ?? false
                }  satisfies Static<typeof req.route.success>
            }
            case "DELETE /user/device/{id}": {
                requireLambdaAuth(req, SessionContextCheck)
                const session = req.principal;
                await cognito.forgetDevice({
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: session.access_token,
                })
                return {}  satisfies Static<typeof req.route.success>
            }
            case "PUT /user/device/{id}": {
                requireLambdaAuth(req, SessionContextCheck)
                const session = req.principal
                const {body} = req.parse()
                await cognito.updateDeviceStatus({
                    DeviceKey: req.pathParameters?.['id'],
                    DeviceRememberedStatus: body.deviceRememberedStatus,
                    AccessToken: session.access_token,
                })
                return {}  satisfies Static<typeof req.route.success>
            }
        }

//#endregion

        async function processAuthResponse(auth: Cognito.InitiateAuthResponse | Cognito.RespondToAuthChallengeResponse) {
            if (auth.AuthenticationResult !== undefined) {
                const {AccessToken, IdToken, RefreshToken, ExpiresIn} = auth.AuthenticationResult
                if (AccessToken === undefined || IdToken === undefined ||
                    RefreshToken === undefined || ExpiresIn === undefined) {
                    throw internalError("Unexpected OIDC provider response").withContext("processAuthResponse", {
                        cognitoResponse: auth.AuthenticationResult
                    })
                }
                return await createNewSession(RefreshToken, IdToken, AccessToken, ExpiresIn);
            } else {
                return {
                    challengeName: auth.ChallengeName,
                    session: auth.Session,
                    challengeParameters: auth.ChallengeParameters
                }
            }
        }

        async function createNewSession(RefreshToken: string, IdToken: string, AccessToken: string, ExpiresIn: number) {
            const {sessions, tokens: oidc} = await startAuthOperation(req.requestContext.requestId, options)
            const tokens = oidc.createTokens(RefreshToken, IdToken, AccessToken, ExpiresIn)
            await Promise.all([tokens.verifyIdToken(), tokens.verifyAccessToken()])
            const session = await sessions.createWithTokens(tokens)
            await session.save()
            return refreshSessionResponse(session);
        }

        /**
         * Create new session cookie to replace the old and invalidate Authorizer cache.
         */
        function refreshSessionResponse(session: SessionData) {
            const cookie = session.newSessionCookie()
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


function secretHash(username: string, clientSecret: string, clientId: string) {
    const hasher = createHmac('sha256', clientSecret);
    hasher.update(`${username}${clientId}`);
    return hasher.digest('base64');
}

async function fetchCognitoAttributes(username: string, userPoolId: string): Promise<UserAttribute[]> {
    const cognitoUser = await cognito.adminGetUser({Username: username, UserPoolId: userPoolId})
    return toUserAttributes(cognitoUser.UserAttributes);
}


function toCodeDeliveryDetails(details?: Cognito.CodeDeliveryDetailsType): CodeDeliveryDetails | undefined {
    if (details === undefined) return undefined

    return {
        attributeName: details.AttributeName,
        deliveryMedium: details.DeliveryMedium,
        destination: details.Destination,
    }
}

function toDevice(device?: Cognito.DeviceType): Device | undefined {
    if (device === undefined) return undefined
    return {
        deviceAttributes: (device.DeviceAttributes ?? [])
            .map(function (attr) {
                return {
                    name: attr.Name,
                    value: attr.Value
                }
            })
            .filter(function (attr): attr is DeviceAttribute {
                return attr !== undefined && attr.name != undefined && attr.value !== undefined
            }),
        deviceCreateDate: device.DeviceCreateDate,
        deviceKey: device.DeviceKey,
        deviceLastAuthenticatedDate: device.DeviceLastAuthenticatedDate,
        deviceLastModifiedDate: device.DeviceLastModifiedDate
    }
}