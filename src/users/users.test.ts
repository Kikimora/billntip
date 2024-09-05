import _ from "lodash";
import * as uuid from "uuid";
import {CognitoIdentityProvider, UserPoolType, AttributeType} from "@aws-sdk/client-cognito-identity-provider";
import * as users from "./index"
import {User} from "./user";
import {
    clearMock,
    chainFixtures,
    makeTestHandler,
    MockResult,
    prepare,
    makeFixture,
    makeContextualFixture, prepareWithContext
} from "@app/test/util";
import {newSession} from "@app/test/cognito";
import {CognitoJwtVerifier} from "aws-jwt-verify";
import {when} from "jest-when";

jest.spyOn(CognitoIdentityProvider.prototype, 'describeUserPoolClient').mockImplementation(() => ({
    UserPoolClient: {
        ClientSecret: "User Pool Client SECRET",
        TokenValidityUnits: {
            AccessToken: "seconds",
            RefreshToken: "seconds"
        },
        AccessTokenValidity: 3600,
        RefreshTokenValidity: 3600
    } as UserPoolType
}));
jest.spyOn(CognitoIdentityProvider.prototype, 'describeUserPool').mockImplementation(() => ({
    UserPool: {
        //TODO add tests for a userpool with username attributes
        //UsernameAttributes: ['email', 'phone_number'],
        UsernameAttributes: undefined,
        AliasAttributes: undefined
    } as UserPoolType
}))

const signUp = makeTestHandler(users.handler, {
    routeKey: "POST /user",
    headers: {'content-Type': 'application/json'}
})
const confirmSignup = makeTestHandler(users.handler, {
    routeKey: "POST /user/confirm",
    headers: {'content-Type': 'application/json'}
})
const initiateAuth = makeTestHandler(users.handler, {
    routeKey: "POST /user/signin",
    headers: {'content-Type': 'application/json'}
})
const respondToAuthChallenge = makeTestHandler(users.handler, {
    routeKey: "POST /user/signin/challenge",
    headers: {'content-Type': 'application/json'}
})
const putUserAttributes = makeTestHandler(users.handler, {
    routeKey: "PUT /user/attributes",
    headers: {'content-Type': 'application/json'},
})
const getUserAttributes = makeTestHandler(users.handler, {
    routeKey: "GET /user/attributes",
})
const createProfilePic = makeTestHandler(users.handler, {
    routeKey: "POST /user/image",
})

const init = prepare('Once', {
    async before() {
        const {userRepo, UserPoolId, ClientId, cognito, s3} = await users.__init()
        const createUser = jest.spyOn(userRepo, 'create')
        const createLockedUser = jest.spyOn(userRepo, 'createLocked')
        return {userRepo, createUser, createLockedUser, UserPoolId, ClientId, cognito, s3}
    },
    async after() {
        await clearUsers()
    }
})

async function clearUsers() {
    const {createUser, createLockedUser, UserPoolId, cognito} = init()
    const deleteUser = async function ({value: user}: MockResult<User>) {
        if (user !== undefined) {
            await user.fetch()
            await user.delete(true)
            await cognito.adminDeleteUser({UserPoolId, Username: user.username}).catch(/*ignore errors*/)
        }
    };
    await clearMock(createUser, deleteUser)
    await clearMock(createLockedUser, deleteUser)
}

const freshUserFixture = makeFixture({
    async before() {
        const {userRepo, s3} = init()
        const username = uuid.v4()
        const password = "Qweqwe_1"
        const email = `${username}@example.com`

        const signupRequest = {
            Username: username,
            Password: password
        }
        const cognitoSignup = jest.spyOn(CognitoIdentityProvider.prototype, 'signUp')
        when(cognitoSignup).calledWith(expect.objectContaining(signupRequest)).mockReturnValue({
            UserConfirmed: false,
            CodeDeliveryDetails: {
                Destination: `${email}`,
                DeliveryMedium: "EMAIL",
                AttributeName: 'email'
            },
            UserSub: username
        } as any)

        return {username, password, email, userRepo, cognitoSignup, s3}
    },
    async after({cognitoSignup}) {
        cognitoSignup.mockClear()
        await clearUsers()
    }
})

describe("POST /user", () => {

    const prepareSignup = prepare('Each', freshUserFixture)

    it("creates user in Cognito and Dynamo, returns cognito response", async () => {
        const {username, password, email, userRepo, cognitoSignup} = prepareSignup()
        //act
        const response = await signUp({
            body: {
                username,
                password,
                userAttributes: [
                    {name: 'email', value: `${email}`},
                    {name: 'attr1', value: "attr1 value"},
                    {name: 'attr2', value: "attr2 value"}
                ],
                validationData: [{name: 'value', value: 'validation data'}],
                clientMetadata: {'metadataKey': 'metadataValue'}
            }
        })

        //assert
        expect(cognitoSignup).toHaveBeenCalledWith(expect.objectContaining({
            Username: username,
            Password: password,
            UserAttributes: [{"Name": "email", "Value": `${email}`}],
            ValidationData: [{Name: 'value', Value: 'validation data'}],
            ClientMetadata: {
                '_attributes': "[{\"name\":\"attr1\",\"value\":\"attr1 value\"},{\"name\":\"attr2\",\"value\":\"attr2 value\"}]",
                'metadataKey': 'metadataValue',
            }
        }))

        expect(response).toEqual({
            userConfirmed: false,
            codeDeliveryDetails: {
                destination: `${email}`,
                deliveryMedium: "EMAIL",
                attributeName: 'email'
            },
            userSub: username
        })
        const user = await userRepo.fetch(username)
        expect(user.attributes).toContainAllValues([
            {name: 'email', value: `${email}`, verified: false},
            {name: 'attr1', value: "attr1 value"},
            {name: 'attr2', value: "attr2 value"}
        ])
    })
    it("fails if user exists", async () => {
        const {username, password} = prepareSignup()
        //act
        const successfulResponse = await signUp({body: {username, password}})
        const failedResponse = await signUp({body: {username, password}})
        //assert
        expect(successfulResponse).toEqual(expect.objectContaining({
            userSub: username
        }))
        expect(failedResponse).toEqual(expect.objectContaining({
            statusCode: "400",
            body: expect.toBeString()
        }))
        expect(JSON.parse(failedResponse.body)).toMatchObject({
            "error": "UsernameExistsException",
            "message": "Username or alias already exists."
        })
    })
    it("fails if too many attributes provided by the user", async () => {
        const {username, password} = prepareSignup()
        const userAttributes = [
            ...Array.from({length: 60}, (_1, i) => ({name: `attr${i}`, value: `attr${i} value`}))
        ];
        //act
        const response = await signUp({body: {username, password, userAttributes}})
        //assert
        expect(response).toEqual({
            statusCode: "400",
            body: expect.toBeString()
        })
        expect(JSON.parse(response.body)).toMatchObject({
            "error": "Error",
            "message": "Expected array length to be less or equal to 50"
        })
    })
})

const signedUserFixture = chainFixtures(freshUserFixture, async function ({username, password}) {
    await signUp({body: {username, password, userAttributes: [{name: "attr", value: "value"}]}})
})

const confirmUserFixture = makeContextualFixture(signedUserFixture, {
    async before({username, email}) {
        const confirmRequest = expect.objectContaining({
            ConfirmationCode: "123456"
        })
        const cognitoConfirmSignUp = jest.spyOn(CognitoIdentityProvider.prototype, 'confirmSignUp')
        when(cognitoConfirmSignUp).calledWith(confirmRequest).mockReturnValue({} as any)
        const getUserRequest = expect.objectContaining({
            Username: username
        })
        const cognitoAdminGetUser = jest.spyOn(CognitoIdentityProvider.prototype, 'adminGetUser')
        when(cognitoAdminGetUser).calledWith(getUserRequest).mockReturnValue({
            UserAttributes: [
                {Name: 'email', Value: email},
                {Name: 'email_verified', Value: 'true'}
            ]
        } as any)
        return {cognitoConfirmSignUp, cognitoAdminGetUser}
    },
    async after({cognitoConfirmSignUp, cognitoAdminGetUser}) {
        cognitoConfirmSignUp.mockClear()
        cognitoAdminGetUser.mockClear()
    }
})

describe("POST /user/confirm", () => {
    const signupUser = prepare('Once', signedUserFixture)
    const prepareConfirm = prepareWithContext('Each', signupUser, confirmUserFixture)

    it("confirm user in cognito", async () => {
        //arrange
        const {username, email, userRepo, cognitoConfirmSignUp} = prepareConfirm()
        //act
        const confirmResponse = await confirmSignup({
            body: {
                username,
                confirmationCode: "123456",
                clientMetadata: {'metadataKey': 'metadataValue'}
            }
        })

        //assert
        expect(confirmResponse).toEqual({})
        expect(cognitoConfirmSignUp).toHaveBeenCalledWith({
            Username: username,
            ConfirmationCode: "123456",
            ClientMetadata: {'metadataKey': 'metadataValue'},
            ClientId: process.env.OAUTH_CLIENT_ID!,
            SecretHash: expect.any(String)
        })
        const user = await userRepo.fetch(username)
        expect(user.attributes).toContainValues([
            {name: "email", value: email, verified: true},
        ])
    })
})

const confirmedUserFixture = chainFixtures(signedUserFixture, confirmUserFixture,
    async function ({username}) {
        await confirmSignup({
            body: {
                username,
                confirmationCode: "123456",
                clientMetadata: {'metadataKey': 'metadataValue'}
            }
        })
    })

const loginFixture = makeContextualFixture(confirmedUserFixture, {
    async before({username, password, email}) {
        const initiateAuthRequest = expect.objectContaining({
            AuthFlow: "USER_PASSWORD_AUTH",
            AuthParameters: expect.objectContaining({
                'USERNAME': username,
                'PASSWORD': password
            })
        })

        const cognitoInitiateAuth = jest.spyOn(CognitoIdentityProvider.prototype, 'initiateAuth')
        const cognitoRespondToAuthChallenge = jest.spyOn(CognitoIdentityProvider.prototype, 'respondToAuthChallenge')
        const verifyToken = jest.spyOn(CognitoJwtVerifier.prototype, 'verify')

        function createTokensWhen(fn: any, authRequest: any) {
            const session = newSession(username, {
                email,
                profile: {
                    "email_verified": true
                }
            })
            when(verifyToken).calledWith(session.id_token).mockReturnValue(session.id_token_json as any)
            when(verifyToken).calledWith(session.access_token).mockReturnValue(session.access_token_json as any)
            when(fn).calledWith(authRequest).mockReturnValue({
                AuthenticationResult: {
                    AccessToken: session.access_token,
                    ExpiresIn: session.id_token_json.exp,
                    RefreshToken: "Cognito Refresh Token",
                    IdToken: session.id_token
                }
            } as any)
            return {lambda: session}
        }

        function initiateAuthCreatesTokens() {
            return createTokensWhen(cognitoInitiateAuth, initiateAuthRequest);
        }

        function initiateAuthChallenge() {
            return when(cognitoInitiateAuth).calledWith(initiateAuthRequest).mockReturnValue({
                ChallengeName: "SMS_MFA",
                Session: "CHALLENGE SESSION",
                ChallengeParameters: {}
            } as any)
        }

        function respondToAuthChallengeCreatesTokens() {
            const respondToAuthChallengeResponse = expect.objectContaining({
                    Session: "XYZ",
                    ChallengeName: "SMS_MFA",
                    ChallengeResponses: expect.objectContaining({
                        "USERNAME": username,
                        "SMS_MFA_CODE": "12345"
                    }),
                    ClientMetadata: {"a": "b"}
                }
            )
            return createTokensWhen(cognitoRespondToAuthChallenge, respondToAuthChallengeResponse);
        }

        return {
            cognitoInitiateAuth,
            cognitoRespondToAuthChallenge,
            verifyToken,
            initiateAuthChallenge,
            initiateAuthCreatesTokens,
            respondToAuthChallengeCreatesTokens
        }
    },
    async after({cognitoInitiateAuth, verifyToken, cognitoRespondToAuthChallenge}) {
        cognitoInitiateAuth.mockClear()
        cognitoRespondToAuthChallenge.mockClear()
        verifyToken.mockClear()
    }
})

describe("POST /user/signin", () => {
    const confirmUser = prepare('Once', confirmedUserFixture)
    const prepareLogin = prepareWithContext('Each', confirmUser, loginFixture)

    it("generates access tokens", async () => {
        const {username, password, email, cognitoInitiateAuth, initiateAuthCreatesTokens} = prepareLogin()
        initiateAuthCreatesTokens()
        const response = await initiateAuth({
            body: {
                authFlow: "USER_PASSWORD_AUTH",
                authParameters: {
                    'USERNAME': username,
                    'PASSWORD': password
                }
            }
        })

        expect(cognitoInitiateAuth).toBeCalled()
        expect(response).toEqual(expect.objectContaining({
            statusCode: 200,
            headers: {
                'Set-Cookie': expect.stringMatching(/SID=.*; Path=\/; Expires=.*; HttpOnly; Secure; Partitioned; SameSite=None/)
            },
            body: expect.toBeString()
        }))
        const {authenticationResult, challengeParameters} = JSON.parse(response.body)
        expect(authenticationResult.accessToken).toBeString()
        expect(authenticationResult.idToken).toBeString()
        expect(authenticationResult.profile).toMatchObject({
            'cognito:username': expect.toBeString(),
            email: email,
            sub: expect.toBeString(),
            token_use: 'id',
            'cognito:groups': [],
            email_verified: true,
            iat: expect.toBeNumber()
        })
        expect(challengeParameters).toBeEmptyObject()
    })
    it("can respond with a challenge", async () => {
        const {username, password, initiateAuthChallenge} = prepareLogin()
        initiateAuthChallenge()
        const response = await initiateAuth({
            body: {
                authFlow: "USER_PASSWORD_AUTH",
                authParameters: {
                    'USERNAME': username,
                    'PASSWORD': password
                }
            }
        })
        expect(response).toEqual(expect.objectContaining({
            challengeName: 'SMS_MFA',
            session: 'CHALLENGE SESSION',
            challengeParameters: {}
        }))
    })
})

describe("POST /user/signin/challenge", () => {

    const confirmUser = prepare('Once', confirmedUserFixture)
    const start2FA = prepareWithContext('Each', confirmUser, loginFixture)

    it("generates access tokens", async () => {
        const {username, email, cognitoRespondToAuthChallenge, respondToAuthChallengeCreatesTokens} = start2FA()
        respondToAuthChallengeCreatesTokens()
        const response = await respondToAuthChallenge({
            body: {
                session: "XYZ",
                challengeName: "SMS_MFA",
                challengeResponses: {
                    "USERNAME": username,
                    "SMS_MFA_CODE": "12345"
                },
                clientMetadata: {"a": "b"}
            }
        })
        expect(cognitoRespondToAuthChallenge).toBeCalledWith(expect.objectContaining({
            Session: "XYZ",
            ChallengeName: "SMS_MFA",
            ChallengeResponses: expect.objectContaining({
                "USERNAME": username,
                "SMS_MFA_CODE": "12345"
            }),
            ClientMetadata: {"a": "b"}
        }))

        expect(response).toEqual(expect.objectContaining({
            statusCode: 200,
            headers: {
                'Set-Cookie': expect.stringMatching(/SID=.*; Path=\/; Expires=.*; HttpOnly; Secure; Partitioned; SameSite=None/)
            },
            body: expect.toBeString()
        }))
        expect(JSON.parse(response.body)).toMatchObject({
            authenticationResult: {
                accessToken: expect.toBeString(),
                idToken: expect.toBeString(),
                profile: expect.objectContaining({
                    'cognito:username': expect.toBeString(),
                    email: email,
                    sub: expect.toBeString(),
                    token_use: 'id',
                    iat: expect.toBeNumber()
                })
            },
            challengeParameters: {}
        })
    })
})

describe("GET /user/session", () => {
    it("require session", () => {
    })
    it("returns session", () => {
    })
})
describe("POST /user/session", () => {
    it("require session", () => {
    })
    it("refresh session using refresh token", () => {
    })
    it("refresh session cookie", () => {
    })
    it("returns session", () => {
    })
})
describe("DELETE /user/session", () => {
    it("require session", () => {
    })
    it("expire refresh token", () => {
    })
    it("removes cookie from browser", () => {
    })
    it("removes session from storage", () => {
    })
})

const authenticatedUserFixture = chainFixtures(confirmedUserFixture, loginFixture,
    async function ({username, password, initiateAuthCreatesTokens}) {
        const session = initiateAuthCreatesTokens()
        const response = await initiateAuth({
            body: {
                authFlow: "USER_PASSWORD_AUTH",
                authParameters: {
                    'USERNAME': username,
                    'PASSWORD': password
                }
            }
        })
        expect(response.statusCode).toBe(200)
        return {session}
    }
)

describe("PUT /user/attributes", () => {
    const authenticateUser = prepare('Once', authenticatedUserFixture)

    it("requires active session", async () => {
        const response = await putUserAttributes({authorizer: undefined})
        expect(response).toEqual({
            statusCode: '401',
            body: expect.toBeString()
        })
        expect(JSON.parse(response.body)).toMatchObject({"error": "Unauthorized", "message": "Unauthorized"})
    })
    it("update attributes in Cognito and DynamoDB", async () => {
        //arrange
        const {userRepo, username, session} = authenticateUser()
        const newEmail = `users.test.new_email@example.com`
        const phone = `+1123123123`
        const {codeDeliveryDetailsList, updateUserAttributes} = setupUpdateAttributes([
            {Name: "email", Value: newEmail},
            {Name: "email_verified", Value: 'false'},
            {Name: "phone_number", Value: phone},
            {Name: "phone_number_verified", Value: 'false'},
        ]);
        //act
        const response = await putUserAttributes({
            body: {
                userAttributes: [
                    {name: "attr", value: "new value"},
                    {name: "new_attr", value: "value"},
                    {name: "email", value: newEmail},
                    {name: "phone_number", value: phone},
                ],
                clientMetadata: {"metaAttr": "metaValue"}
            },
            authorizer: session
        })

        //assert
        expect(response).toEqual(expect.objectContaining({
            attributes: expect.arrayContaining([
                {name: "attr", value: "new value"},
                {name: "new_attr", value: "value"},
                {name: "email", value: newEmail, verified: false},
                {name: "phone_number", value: phone, verified: false},
            ]),
            codeDeliveryDetailsList: codeDeliveryDetailsList.map(x => _.mapKeys(x, (_1, k) => _.lowerFirst(k)))
        }))
        expect(updateUserAttributes).toHaveBeenCalledWith({
            UserAttributes: [
                {Name: "email", Value: newEmail},
                {Name: "phone_number", Value: phone}
            ],
            ClientMetadata: {"metaAttr": "metaValue"},
            AccessToken: session.lambda.access_token,
        })
        const user = await userRepo.fetch(username)
        expect(user.attributes).toContainValues([
            {name: "attr", value: "new value"},
            {name: "new_attr", value: "value"},
            {name: "email", value: newEmail, verified: false},
            {name: "phone_number", value: phone, verified: false},
        ])
    })

    it("handles empty attribute value", async () => {
        const {session} = authenticateUser()
        const response = await putUserAttributes({
            body: {
                userAttributes: [
                    {name: "attr", value: ""},
                ]
            },
            authorizer: session
        })
        expect(response).toEqual(expect.objectContaining({
            attributes: expect.arrayContaining([
                {name: "attr", value: ""},
            ]),
            codeDeliveryDetailsList: undefined
        }))
    })
})

describe("GET /user/attributes", () => {
    const authenticateUser = prepare('Once', authenticatedUserFixture)

    it("requires active session", async () => {
        const response = await getUserAttributes({authorizer: undefined})
        expect(response).toEqual({
            statusCode: '401',
            body: expect.toBeString()
        })
        expect(JSON.parse(response.body)).toMatchObject({"error": "Unauthorized", "message": "Unauthorized"})
    })
    it("returns attributes from Cognito and DynamoDB", async () => {
        const {session, email} = authenticateUser()
        const response = await getUserAttributes({authorizer: session})
        expect(response).toContainValues([
            {name: "attr", value: "value"},
            {name: "email", value: email, verified: true}
        ])
    })
})


describe("POST /user/image", () => {
    const authenticateUser = prepare('Once', authenticatedUserFixture)

    it("requires active session", async () => {
        const response = await createProfilePic({authorizer: undefined})
        expect(response).toEqual({
            statusCode: '401',
            body: expect.toBeString()
        })
        expect(JSON.parse(response.body)).toMatchObject({"error": "Unauthorized", "message": "Unauthorized"})
    })

    it("generates profile upload", async () => {
        const {session, s3} = authenticateUser()
        const response = await createProfilePic({authorizer: session})
        console.log(response)
        expect(response).toMatchObject({
            url: expect.toBeString(),
            fields: {
                bucket: s3.bucket,
                'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
                'X-Amz-Credential': expect.toBeString(),
                'X-Amz-Date': expect.toBeString(),
                'X-Amz-Security-Token': expect.toBeString(),
                key: `${s3.tmpPrefix}/${session.lambda.id}`,
                Policy: expect.toBeString(),
                'X-Amz-Signature': expect.toBeString()
            }
        })
        expect(response.url).toMatch(`https://${s3.bucket}.s3.eu-south-1.amazonaws.com/`)
    })
})

function setupUpdateAttributes(attributes: AttributeType[]) {

    const codeDeliveryDetailsList = attributes
        .filter(x => x.Name === 'email' || x.Name === 'phone_number')
        .map(x => ({
            Destination: x.Value,
            DeliveryMedium: x.Name === 'email' ? "EMAIL" : 'SMS',
            AttributeName: x.Name
        }))

    const updateUserAttributes = jest.spyOn(CognitoIdentityProvider.prototype, 'updateUserAttributes')
        .mockReturnValue({
            CodeDeliveryDetailsList: codeDeliveryDetailsList.length > 0 ? codeDeliveryDetailsList : undefined
        } as any)

    jest.spyOn(CognitoIdentityProvider.prototype, 'adminGetUser')
        .mockReturnValue({
            UserAttributes: attributes,
        } as any)
    return {codeDeliveryDetailsList, updateUserAttributes};
}


