import {
    CognitoIdentityProvider,
    InitiateAuthResponse,
    RespondToAuthChallengeResponse,
    UnauthorizedException
} from "@aws-sdk/client-cognito-identity-provider";
import {createHmac} from "crypto";
import {jwtDecode} from "jwt-decode";
import {Static, Type} from "@sinclair/typebox";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import _, {die, toCamelCase} from "@app/util";
import {
    badRequestError,
    HttpError,
    internalError,
    Middleware,
    pipeline,
    requireLambdaAuth,
    TracedEvent,
    moduleConfig
} from "@app/lambda";
import diagnostics from "@app/diagnostics";
import startAuthOperation, {SessionData, AuthOptionsSchema, SessionContextCheck} from "@src/authorizer/operation";
import Paths from "./paths";
import * as Schemas from "./schemas";
import UserRepo, {invalidAliasException, UserAttribute} from "./user"
import {toUserAttributes} from "./cognito"

const cognito = new CognitoIdentityProvider()
const dynamo = new DynamoDB()
const config = moduleConfig()
    .parameters(AuthOptionsSchema)
    .parameters({dynamodb: Type.Object({users: Type.String()})})
    .parameters({'users-diagnostics': diagnostics.OptionsSchema})
    .build()

/**
 * Static initialisation.
 */
export function __init() {
    return config.parameters.then(async function (options) {
        const {dynamodb, oidc, api, 'users-diagnostics': diagnosticsConfig} = options
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
            ClientSecret: clientSecret,
            UserPoolId: oidc.userPoolId,
            ClientId: api.clientId,
            UsernameAttributes: usernameAttributes,
            userRepo,
            options
        }
    })
}

declare module "@aws-sdk/client-cognito-identity-provider" {
    interface UnauthorizedException extends HttpError {
    }
}
Object.defineProperty(UnauthorizedException.prototype, 'statusCode', {
    value: '401', writable: false
})


export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .withRoutes(Paths)
    .parseJsonBody()
    .do(async function (this: Middleware, e: TracedEvent, ctx: any) {
        let response = await this.next(e, ctx)
        //cleanup AWS noise
        delete response?.$metadata
        if ('statusCode' in response) {
            if (response.body !== undefined && typeof response.body !== 'string')
                response.body = toCamelCase(response.body)
        } else {
            response = toCamelCase(response)
        }
        return response
    })
    .done(async function (req) {
        const {ClientSecret, UserPoolId, ClientId, UsernameAttributes, userRepo, options} = await __init()
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

                async function signUp(username: string) {
                    const attributes = body.userAttributes ?? [];
                    const aliases = userRepo.aliases(attributes)
                    const metadata = {
                        ...body.clientMetadata,
                        _attributes: JSON.stringify(userRepo.normalAttributes(attributes))
                    }
                    return await cognito.signUp({
                        Username: username,
                        Password: body.password,
                        UserAttributes: aliases?.map(x => ({Name: x.name, Value: x.value})),
                        ClientMetadata: metadata,
                        ValidationData: body.validationData?.map(x => ({Name: x.name, Value: x.value})),
                        ClientId,
                        SecretHash: secretHash(username, ClientSecret, ClientId)
                    })
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
                    const userId = response.UserSub
                    if (userId === undefined)
                        throw internalError("Unexpected error - Cognito didn't generate user id")
                    const cognitoAliases = await fetchCognitoAttributes(userId, UserPoolId)
                    const attributes = userRepo.normalAttributes(body.userAttributes ?? [])
                    await userRepo.create(userId, 'trusted', attributes.concat(cognitoAliases))
                    return response
                } else {
                    /**
                     * In this mode username cannot be equal to any of alias attributes which is guaranteed by the user repo.
                     */
                    await userRepo.create(body.username, 'user', body.userAttributes)
                    return await signUp(body.username)
                }
            }
            case "POST /user/confirm": {
                const {body} = req.parse()
                const poolUseUsernameAttributes = (UsernameAttributes.length ?? 0) > 0;
                const user = await userRepo.fetchLocked(body.username, {
                    allowUnverifiedAlias: poolUseUsernameAttributes
                })
                try {
                    const cognitoResponse = await cognito.confirmSignUp({
                        Username: user.username,
                        ConfirmationCode: body.confirmationCode,
                        ClientMetadata: body.clientMetadata,
                        ClientId,
                        SecretHash: secretHash(user.username, ClientSecret, ClientId)
                    })
                    const cognitoAttributes = await fetchCognitoAttributes(body.username, UserPoolId);
                    await user.updateAttributes('trusted', cognitoAttributes)
                    return cognitoResponse
                } finally {
                    await user.unlock()
                }
            }
            case "POST /user/resend_confirmation_code": {
                const {body} = req.parse()
                const {username} = await userRepo.lookupAlias(body.username)
                return await cognito.resendConfirmationCode({
                    Username: username,
                    ClientMetadata: body.clientMetadata,
                    ClientId,
                    SecretHash: secretHash(username, ClientSecret, ClientId)
                })
            }
//#endregion
//#region Attributes
            case 'GET /user/attributes': {
                requireLambdaAuth(req, SessionContextCheck)
                const username = req.principal.id_token_json['cognito:username']
                const user = await userRepo.fetch(username)
                return user.attributes satisfies Readonly<Static<typeof req.route.success>>
            }
            case "PUT /user/attributes": {
                requireLambdaAuth(req, SessionContextCheck)
                const {body} = req.parse()
                const username = req.principal.id_token_json['cognito:username']
                let codeDeliveryDetailsList

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
                        codeDeliveryDetailsList = response.CodeDeliveryDetailsList
                    }
                    const normalAttributes = userRepo.normalAttributes(bodyAttributes)
                    const cognitoAttributes = await fetchCognitoAttributes(user.username, UserPoolId)
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
                return await cognito.forgotPassword({
                    ClientMetadata: body.clientMetadata,
                    Username: username,
                    ClientId,
                    SecretHash: secretHash(username, ClientSecret, ClientId)
                })
            }
            case "POST /user/password/confirm": {
                const {body} = req.parse()
                const {username} = await userRepo.lookupAlias(body.username)
                return await cognito.confirmForgotPassword({
                    Username: username,
                    ClientMetadata: body.clientMetadata,
                    Password: body.password,
                    ConfirmationCode: body.confirmationCode,
                    ClientId,
                    SecretHash: secretHash(username, ClientSecret, ClientId),
                })
            }
//#endregion
//#region Devices
            case "GET /user/devices": {
                requireLambdaAuth(req, SessionContextCheck)
                const session = req.principal;
                const {body} = req.parse()
                return await cognito.listDevices({
                    Limit: body.limit,
                    PaginationToken: body.paginationToken,
                    AccessToken: session.access_token,
                })
            }
            case "GET /user/device/{id}": {
                requireLambdaAuth(req, SessionContextCheck)
                const session = req.principal;
                return await cognito.getDevice({
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: session.access_token,
                })
            }
            case "PUT /user/device/{id}/confirm": {
                requireLambdaAuth(req, SessionContextCheck)
                const session = req.principal;

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
                requireLambdaAuth(req, SessionContextCheck)
                const session = req.principal;
                return await cognito.forgetDevice({
                    DeviceKey: req.pathParameters?.['id'],
                    AccessToken: session.access_token,
                })
            }
            case "PUT /user/device/{id}": {
                requireLambdaAuth(req, SessionContextCheck)
                const session = req.principal
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
                    throw internalError("Unexpected OIDC provider response").withContext("processAuthResponse", {
                        cognitoResponse: auth.AuthenticationResult
                    })
                }
                return await createNewSession(RefreshToken, IdToken, AccessToken, ExpiresIn);
            } else {
                return auth
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



