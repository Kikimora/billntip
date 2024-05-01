import _ from "lodash";
import * as uuid from "uuid";
import {CognitoIdentityProvider, UserPoolType} from "@aws-sdk/client-cognito-identity-provider";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import * as jwt from 'jsonwebtoken'
import {SessionContext} from "@src/authorizer/session";
import * as users from "./index"
import UserRepo from "@src/users/user";
import {Tracer} from "@app/diagnostics";
import FunctionPropertyNames = jest.FunctionPropertyNames;

jest.mock('@aws-sdk/client-cognito-identity-provider')

const handler = async function (req: any, auth?: SessionContext) {
    if (req.body !== undefined)
        req.body = JSON.stringify(req.body, null, 2)

    req = _.merge(req, {
        headers: {'content-type': 'application/json'},
        requestContext: {
            requestId: `${uuid.v4()}`
        },
    }, auth !== undefined ? {
        requestContext: {
            authorizer: {
                lambda: auth
            }
        }
    } : undefined)
    const response = await users.handler(req, {functionName: "users", functionVersion: "Test"} as any)
    if ('statusCode' in response && 'body' in response && typeof response.body === "string") {
        return {
            ...response,
            body: JSON.parse(response.body)
        }
    }
    return response
}

beforeAll(async () => {
    jest.resetModules()
    jest.clearAllMocks()

    jest.spyOn(CognitoIdentityProvider.prototype, 'describeUserPoolClient')
        .mockImplementation(() => ({
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
})

const dynamo = new DynamoDB()

let username!: string
let email!: string
let newEmail!: string
let phone!: string
let userRepo!: UserRepo
beforeEach(() => {
    username = uuid.v4()
    email = `${username}@example.com`
    newEmail = `new_email@example.com`
    phone = `+1123123123`
    userRepo = new UserRepo({
        tracer: new Tracer("test"),
        requestContext: {requestId: uuid.v4()}
    } as any, dynamo)
})
afterEach(async () => {
    try {
        const user = await userRepo.fetch(username)
        await user.delete(true)
    } catch (e: any) {
        if (e.name !== 'UserNotFoundException') throw e
    }
})

describe("Signup process", () => {
    let signupMock!: jest.SpyInstance

    beforeEach(() => ({signupMock} = setupSignup()))

    describe("POST /user", () => {
        it("creates user in Cognito and Dynamo, returns cognito response", async () => {
            //act
            const response = await signUp({
                userAttributes: [
                    {name: 'email', value: `${email}`},
                    {name: 'attr1', value: "attr1 value"},
                    {name: 'attr2', value: "attr2 value"}
                ],
                validationData: [{name: 'value', value: 'validation data'}],
                clientMetadata: {'metadataKey': 'metadataValue'}
            })
            //assert
            expect(signupMock).toHaveBeenCalledWith(expect.objectContaining({
                Username: username,
                Password: "Qweqwe_1",
                UserAttributes: [{"Name": "email", "Value": `${email}`}],
                ValidationData: [{Name: 'value', Value: 'validation data'}],
                ClientMetadata: {'metadataKey': 'metadataValue'}
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
            //act
            const successfulResponse = await signUp()
            const failedResponse = await signUp()
            //assert
            expect(successfulResponse).toEqual(expect.objectContaining({
                userSub: username
            }))
            expect(failedResponse).toEqual(expect.objectContaining({
                statusCode: "400",
                body: {"error": "UsernameExistsException", "message": "Username or alias already exists."}
            }))
        })
        it("fails if too many attributes provided by the user", async () => {
            const userAttributes = [
                ...Array.from({length: 60}, (_1, i) => ({name: `attr${i}`, value: `attr${i} value`}))
            ];
            //act
            const response = await signUp({userAttributes})
            //assert
            expect(response).toEqual({
                statusCode: "400",
                body: expect.objectContaining({
                    "error": "Error",
                    "message": "Expected array length to be less or equal to 50"
                })
            })
        })
    })

    describe("POST /user/confirm", () => {
        beforeEach(setupSignup)
        beforeEach(signUp)

        it("confirm user in cognito", async () => {
            //arrange
            const {confirmSignupMock} = setupConfirmSignup({
                UserAttributes: [{Name: 'email', Value: email}, {Name: 'email_verified', Value: 'true'}]
            })
            //act
            const confirmResponse = await confirmSignup({
                confirmationCode: "123456",
                clientMetadata: {'metadataKey': 'metadataValue'}
            })

            //assert
            expect(confirmResponse).toEqual({})
            expect(confirmSignupMock).toHaveBeenCalledWith({
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
})

function setupSignup() {
    const signupMock = jest.spyOn(CognitoIdentityProvider.prototype, 'signUp')
        .mockReturnValue({
            UserConfirmed: false,
            CodeDeliveryDetails: {
                Destination: `${email}`,
                DeliveryMedium: "EMAIL",
                AttributeName: 'email'
            },
            UserSub: username
        } as any)
    return {signupMock}
}

async function signUp(request?: any) {
    return await handler({
        routeKey: "POST /user",
        body: {
            username: username,
            password: "Qweqwe_1",
            ...request
        }
    })
}

function setupConfirmSignup(userAfterSignup?: any) {
    const confirmSignupMock = jest
        .spyOn(CognitoIdentityProvider.prototype, 'confirmSignUp')
        .mockReturnValue({} as any)
    const adminGetUserMock = jest.spyOn(CognitoIdentityProvider.prototype, 'adminGetUser')
        .mockReturnValue({
            UserAttributes: [],
            ...userAfterSignup
        })
    return {confirmSignupMock, adminGetUserMock}
}

function confirmSignup(request: any) {
    const confirmRequest = {
        routeKey: "POST /user/confirm",
        body: {
            username,
            ...request
        }
    }
    return handler(confirmRequest)
}


//Alternative
//GET  /user/attributes - get user attributes and prefill the form
//PUT  /user/attributes - update user attributes
//POST /tip/registration - add user to the group
//POST /user/session - get new tokens and cookie

describe("Session", () => {

    beforeEach(async () => {
        setupSignup()
        await signUp()
        setupConfirmSignup()
        await confirmSignup({
            UserAttributes: [{Name: 'email', Value: email}, {Name: 'email_verified', Value: 'true'}]
        })
    })

    describe("POST /user/signin", () => {
        it("generates access tokens", async () => {
            const {mock: initiateAuthMock} = setupAuthResponse('initiateAuth', {
                "cognito:groups": ["admin"],
                "email_verified": true
            })
            const response = await initiateAuth()

            expect(initiateAuthMock).toBeCalled()
            expect(response).toEqual(expect.objectContaining({
                statusCode: 200,
                headers: {
                    'set-Cookie': expect.stringMatching(/SID=.*; Path=\/; Expires=.*; HttpOnly; Secure; SameSite=None/)
                },
                body: {
                    authenticationResult: {
                        accessToken: expect.toBeString(),
                        idToken: expect.toBeString(),
                        profile: {
                            'cognito:username': expect.toBeString(),
                            email: email,
                            sub: expect.toBeString(),
                            token_use: 'id',
                            'cognito:groups': ["admin"],
                            email_verified: true,
                            iat: expect.toBeNumber()
                        }
                    },
                    challengeParameters: {}
                }
            }))
        })
        it("can respond with a challenge", async () => {
            setupAuthChallengeResponse('initiateAuth')
            const response = await initiateAuth()
            expect(response).toEqual(expect.objectContaining({
                challengeName: 'SMS_MFA',
                session: 'CHALLENGE SESSION',
                challengeParameters: {}
            }))
        })
    })

    describe("POST /user/signin/challenge", () => {
        beforeEach(async ()=>{
            setupAuthResponse('initiateAuth')
            await initiateAuth()
        })
        it("generates access tokens", async () => {
            const {mock: respondToAuthChallengeMock} = setupAuthResponse('respondToAuthChallenge')
            const response = await respondToAuthChallenge({
                session: "XYZ",
                challengeName: "SMS_MFA",
                challengeResponses: {
                    "USERNAME": username,
                    "SMS_MFA_CODE": "12345"
                },
                clientMetadata: {"a": "b"}
            })
            expect(respondToAuthChallengeMock).toBeCalledWith(expect.objectContaining({
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
                    'set-Cookie': expect.stringMatching(/SID=.*; Path=\/; Expires=.*; HttpOnly; Secure; SameSite=None/)
                },
                body: {
                    authenticationResult: {
                        accessToken: expect.toBeString(),
                        idToken: expect.toBeString(),
                        profile: {
                            'cognito:username': expect.toBeString(),
                            email: email,
                            sub: expect.toBeString(),
                            token_use: 'id',
                            iat: expect.toBeNumber()
                        }
                    },
                    challengeParameters: {}
                }
            }))
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

})

function setupAuthResponse(method: FunctionPropertyNames<Required<CognitoIdentityProvider>> = 'initiateAuth',
                           authResponse?: any) {
    const private_key = 'private_key';
    const access = {};
    const accessToken = jwt.sign(access, private_key, {algorithm: 'HS256'});
    const expiresIn = 3600;
    const profile = {
        "cognito:username": username,
        "email": email,
        "sub": username,
        "token_use": "id",
        ...authResponse
    };
    const idToken = jwt.sign(profile, private_key, {algorithm: 'HS256'});
    const mock = jest.spyOn(CognitoIdentityProvider.prototype, method)
        .mockReturnValue({
            AuthenticationResult: {
                AccessToken: accessToken,
                ExpiresIn: expiresIn,
                RefreshToken: "Cognito Refresh Token",
                IdToken: idToken
            }
        } as any)
    const session = {
        id: "SessionId:123",
        access,
        access_token: accessToken,
        profile,
        id_token: idToken,
        expires_at: Date.now() / 1000 + expiresIn,
    };
    return {session, mock}
}

function setupAuthChallengeResponse(method: FunctionPropertyNames<Required<CognitoIdentityProvider>> = 'respondToAuthChallenge',
                                    authResponse?: any) {
    return jest.spyOn(CognitoIdentityProvider.prototype, method)
        .mockReturnValue({
            ChallengeName: "SMS_MFA",
            Session: "CHALLENGE SESSION",
            ChallengeParameters: {},
            ...authResponse
        } as any)
}

function initiateAuth(body?: any) {
    return handler({
        routeKey: "POST /user/signin",
        body: {
            authFlow: "USER_PASSWORD_AUTH",
            authParameters: {
                'USERNAME': username,
                password: "Qweqwe_1"
            },
            ...body
        }
    })
}

function respondToAuthChallenge(body?: any) {
    return handler({
        routeKey: "POST /user/signin/challenge",
        body
    })
}

describe("Attributes", () => {

    let auth!: SessionContext
    beforeEach(async () => {
        setupSignup()
        await signUp({userAttributes: [{name: "attr", value: "value"}, {name: "email", value: email}]})
        setupConfirmSignup({UserAttributes: []})
        await confirmSignup({confirmationCode: "123456"})
        const {session} = setupAuthResponse('initiateAuth', {"cognito:groups": [], "email_verified": true})
        auth = session
        await initiateAuth()
    })

    describe("PUT /user/attributes", () => {
        it("requires active session", async () => {
            const response = await putUserAttributes()
            expect(response).toEqual({
                statusCode: '401',
                body: {"error": "Error", "message": "Lambda authorizer required for the event."}
            })
        })
        it("update attributes in Cognito and DynamoDB", async () => {
            //arrange
            const codeDeliveryDetailsList = [{
                Destination: newEmail,
                DeliveryMedium: "EMAIL",
                AttributeName: "email"
            }, {
                Destination: phone,
                DeliveryMedium: "SMS",
                AttributeName: "phone_number"
            }];
            const updateMock = jest.spyOn(CognitoIdentityProvider.prototype, 'updateUserAttributes')
                .mockReturnValue({
                    CodeDeliveryDetailsList: codeDeliveryDetailsList
                } as any)
            jest.spyOn(CognitoIdentityProvider.prototype, 'adminGetUser')
                .mockReturnValue({
                    UserAttributes: [
                        {Name: "email", Value: newEmail},
                        {Name: "email_verified", Value: 'false'},
                        {Name: "phone_number", Value: phone},
                        {Name: "phone_number_verified", Value: 'false'},
                    ],
                } as any)

            //act
            const response = await putUserAttributes({
                userAttributes: [
                    {name: "attr", value: "new value"},
                    {name: "new_attr", value: "value"},
                    {name: "email", value: newEmail},
                    {name: "phone_number", value: phone},
                ],
                clientMetadata: {"metaAttr": "metaValue"}
            }, auth)

            //assert
            expect(response).toEqual({
                codeDeliveryDetailsList: codeDeliveryDetailsList.map(x => _.mapKeys(x, (v, k) => _.lowerFirst(k)))
            })
            expect(updateMock).toHaveBeenCalledWith({
                UserAttributes: [
                    {Name: "email", Value: newEmail},
                    {Name: "phone_number", Value: phone}
                ],
                ClientMetadata: {"metaAttr": "metaValue"},
                AccessToken: auth.access_token,
            })
            const user = await userRepo.fetch(username)
            expect(user.attributes).toContainValues([
                {name: "attr", value: "new value"},
                {name: "new_attr", value: "value"},
                {name: "email", value: newEmail, verified: false},
                {name: "phone_number", value: phone, verified: false},
            ])
        })
    })

    describe("GET /user/attributes", () => {
        it("requires active session", async () => {
            const response = await getUserAttributes()
            expect(response).toEqual({
                statusCode: '401',
                body: {"error": "Error", "message": "Lambda authorizer required for the event."}
            })
        })
        it("returns attributes from Cognito and DynamoDB", async () => {
            const response = await getUserAttributes(auth)
            expect(response).toContainValues([
                {name: "attr", value: "value"},
                {name: "email", value: email, verified: false}
            ])
        })
    })
})

function putUserAttributes(attrs?: any, auth?: any) {
    return handler({
        routeKey: "PUT /user/attributes",
        body: attrs
    }, auth)
}

function getUserAttributes(auth?: any) {
    return handler({
        routeKey: "GET /user/attributes",
    }, auth)
}

