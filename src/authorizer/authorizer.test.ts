import 'jest-extended';
import {
    APIGatewayAuthorizerEvent,
    APIGatewayProxyStructuredResultV2,
    Context
} from "aws-lambda";
import _ from "lodash";
import {LambdaRequest} from "@app/lambda"
import http from "@src/http"
import {init as dynamoDbInit} from '@app/test/dynamodb'
import {resources} from "@app/test/util";
import {AxiosResponse} from "axios";
import {makeLockStore} from "@app/dynamodb";
import diagnostics from "@app/diagnostics";
import {jwtDecode} from "jwt-decode";
import {code, cookie, hooks, Metrics} from "@src/authorizer";
import {TokenEndpointResponse} from "@src/authorizer/oidc_tokens";
import {TestGroup, fetchCognitoDetails} from "@app/test/cognito";

const httpMock = http as jest.Mocked<typeof http>;
const {default: httpReal} = jest.requireActual('@src/http');
const SessionKey = 'SID';
const {dynamodb, api, cognito, tokenEndpoint} = prepareAuthorizerEnvironment();
const ddb = dynamoDbInit(dynamodb.sessionsTable.name)

const event: LambdaRequest = {
    routeKey: "",
    rawPath: "",
    headers: {},
    rawQueryString: "",
    requestContext: {authorizer: undefined} as any,
    version: "2.0",
    isBase64Encoded: false
}

const cognitoMock = async function (url: string, data: any, config: any) {
    const request = [url, data.grant_type, data.code];
    if (_.isMatch(request, [tokenEndpoint, 'authorization_code', goodAuthorizationCode])) {
        return {
            status: 200,
            data: await testContext.user!.login()
        }
    }
    if (_.isMatch(request, [tokenEndpoint, 'authorization_code', brokenAuthorizationCode])) {
        const tokens = await testContext.user!.login()
        return {
            status: 200,
            data: {...tokens, id_token: tokens?.id_token!.slice(50)}
        }
    }
    if (_.isMatch(request, [tokenEndpoint, 'authorization_code', triggerUnexpectedError])) {
        return {status: 500}
    }
    if (url == tokenEndpoint)
        return await httpReal.post(tokenEndpoint, data, config)
    return {status: 500}
};

const authEvent: APIGatewayAuthorizerEvent = {
    type: "REQUEST",
    methodArn: "",
    resource: "",
    path: "",
    httpMethod: "",
    headers: {
        'Cookie': 'SID=abc.xyz'
    },
    multiValueHeaders: {},
    pathParameters: null,
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    requestContext: {} as any,
    stageVariables: null
}

// noinspection JSDeprecatedSymbols
const awsContext: Context = {
    awsRequestId: "REQUEST ID",
    functionVersion: "$LATEST",
    callbackWaitsForEmptyEventLoop: false,
    functionName: "test",
    invokedFunctionArn: "arn:aws:test",
    memoryLimitInMB: "1000",
    logGroupName: "none",
    logStreamName: "none",
    getRemainingTimeInMillis() {
        return 1000
    },
    done() {
    },
    fail() {
    },
    succeed() {
    }
}

async function initTestContext() {
    const group = await TestGroup.fetch()
    const user = await group.createUniqueUser()
    const {refreshTokenTtl} = await fetchCognitoDetails()
    return {group, user, refreshTokenTtl}
}

let testContext: Awaited<ReturnType<typeof initTestContext>>

beforeAll(async () => {
    testContext = await initTestContext();
    httpMock.post.mockImplementation(cognitoMock);
})

afterAll(async () => {
    await testContext.user?.delete()
    Metrics.stop()
})

beforeEach(() => {
    //Restore mock implementation back to default as it might have changed by the previous test
    httpMock.post.mockImplementation(cognitoMock);
})

describe('OAuth callback validation', () => {
    it('requires `code` parameter in the query string', async () => {
        const samples = [
            null,
            {queryStringParameters: {}},
            {queryStringParameters: {'code': ""}},
            {queryStringParameters: {'code': "123"}}
        ];
        for (let sample of samples) {
            const response = await code({...event, ...sample}, awsContext);
            expect(response).toMatchObject({statusCode: 400})
        }
    })
    it('verifies token signature and throws', async () => {
        const sample = {queryStringParameters: {'code': brokenAuthorizationCode}}
        await expect(code({...event, ...sample}, awsContext)).rejects.toThrow()
    })
    it('throws if token endpoint responds with unexpected error', async () => {
        const sample = {queryStringParameters: {'code': triggerUnexpectedError}}
        await expect(code({...event, ...sample}, awsContext)).rejects.toThrow()
    })
})

describe('OAuth callback', () => {
    let response, cookie: any
    beforeAll(async () => {
        const sample = {queryStringParameters: {'code': goodAuthorizationCode}}
        response = await code({...event, ...sample}, awsContext);
        cookie = parseSetCookieHeader(response)
    })
    it('issues session cookie', async () => {
        expect(cookie).toEqual(expect.objectContaining(sessionCookie()))
        const expires = new Date(cookie!['Expires'] as string);
        expect(expires).toBeAfter(new Date())
    })
    it('exchanges code for tokens', async () => {
        expect(httpMock.post).toHaveBeenCalledWith(
            tokenEndpoint,
            expect.objectContaining({
                'grant_type': 'authorization_code',
                'code': goodAuthorizationCode
            }),
            expect.anything()
        )
    })
    it('creates session in dynamodb', async () => {
        const sessionId = cookie[SessionKey]
        const session = await ddb.getSession(sessionId)
        expect(session).toEqual(expect.objectContaining({
            'session_id': sessionId,
            'id_token': expect.toBeString(),
            'access_token': expect.toBeString(),
            'refresh_token': expect.toBeString(),
            'expires_at': expect.toBePositive(),
            'refresh_token_expires_at': expect.toBePositive(),
            'cached_till': 0
        }))
        expect(session!['lock']).toBeUndefined()

        const now = Math.floor(Date.now() / 1000)
        const sessionExpiresAt = session!['refresh_token_expires_at']
        expect(sessionExpiresAt).toBeCloseTo(now + testContext.refreshTokenTtl, -1)
        const expiresAt = session!['expires_at']
        const refreshCall = _.last(httpMock.post.mock.results)?.value;
        const tokenResponse = await refreshCall as AxiosResponse<TokenEndpointResponse>
        expect(expiresAt).toBeCloseTo(now + tokenResponse.data.expires_in, -1)
    })
    it('issues HTML redirect to configured return url', async () => {
        expect(response!).toEqual(expect.objectContaining({
            statusCode: 200,
            headers: {
                'Set-Cookie': expect.any(String),
                'Content-Type': "text/html"
            },
            body: expect.stringMatching(/http-equiv="refresh"/)
        }))
    })
})

describe('Lambda authorizer validation', () => {
    it('require Cookie header', async () => {
        const response = await cookie({...authEvent, headers: {}}, awsContext)
        expect(response.isAuthorized).toBeFalse()
    })
    it('requires session id in the Cookie header', async () => {
        const response = await cookie({...authEvent, headers: {'Cookie': 'SomeCookie=1'}}, awsContext)
        expect(response.isAuthorized).toBeFalse()
    })
    it('requires session to be present in dynamodb', async () => {
        const response = await cookie({...authEvent, headers: {'Cookie': `${SessionKey}=1`}}, awsContext)
        expect(response.isAuthorized).toBeFalse()
    })
})

describe('Lambda authorizer', () => {
    let sessionId: string
    beforeEach(async () => {
        diagnostics({
            triggers: {
                info: true,
                warn: true
            }
        })
        sessionId = await startSession();
        hooks.cookieAuthorizerStart = jest.fn().mockImplementation(async function () {
            //Verify session locked before business logic starts
            const store = makeLockStore(dynamodb.locksTable.name)
            const sessionLock = await store.load(sessionId)
            expect(sessionLock).toEqual(expect.objectContaining({
                pk: sessionId,
                version: expect.any(Number),
                owner: 'REQUEST ID'
            }))
        })
        hooks.cookieAuthorizerRefresh = jest.fn()
        hooks.cookieAuthorizerFinish = jest.fn().mockImplementation(async function () {
                //Verify session is unlocked when done
                const session = await ddb.getSession(sessionId)
                expect(session?.lock).toBeNil()
            }
        )
    })
    afterEach(() => {
        delete hooks.cookieAuthorizerStart
        delete hooks.cookieAuthorizerRefresh
        delete hooks.cookieAuthorizerFinish
    })

    it('authorises request if no refresh needed', async () => {
        const response = await authorize(sessionId)
        expect(response.isAuthorized).toBeTruthy()
    })
    it('locks and unlocks session', async () => {
        //This test verifies that hooks setup in the setup stage are being called.
        //Because hooks verify session locking this test ensures session was locked and unlocked.
        await authorize(sessionId)
        expect(hooks.cookieAuthorizerStart).toHaveBeenCalled()
        expect(hooks.cookieAuthorizerFinish).toHaveBeenCalled()
    })

    describe('refreshes tokens and rotates cookie', () => {
        let sessionBefore: any;
        beforeEach(async () => {
            sessionBefore = await ddb.updateSession(sessionId, {'expires_at': 1})
            expect(sessionBefore).not.toBeNil()
        })
        it('executes refresh_token grant with saved refresh token', async () => {
            await authorize(sessionId)
            expect(hooks.cookieAuthorizerRefresh).toHaveBeenCalled()
            expect(httpMock.post).toHaveBeenCalledWith(
                tokenEndpoint,
                expect.objectContaining({
                    'grant_type': 'refresh_token',
                    'refresh_token': sessionBefore['refresh_token']!
                }),
                expect.anything()
            )
        })
        it('saves new tokens to dynamodb', async () => {
            const authResult = await authorize(sessionId)
            const {context} = authResult
            const cookieHeader = parseSessionCookieHeader(context!.new_cookie!)
            //const {id} = SessionCookie.load(context!.new_cookie!)!
            const id = cookieHeader[SessionKey] as string
            const sessionAfter = (await ddb.getSession(id))!
            expect(hooks.cookieAuthorizerRefresh).toHaveBeenCalled()
            expect(sessionAfter.access_token).not.toEqual(sessionBefore['access'])
            expect(sessionAfter.id).not.toEqual(sessionBefore['id_token'])
            expect(sessionAfter.refresh_token).toEqual(sessionBefore['refresh_token'])
            expect(sessionAfter.expires_at).toBeGreaterThan(sessionBefore['expires_at'])
            expect(sessionAfter.session_expires_at).toEqual(sessionBefore['session_expires_at'])
        })
        it('return new session cookie and tokens', async () => {
            const response = await authorize(sessionId)
            const cookieHeader = parseSessionCookieHeader(response.context!.new_cookie!)
            const newSession = (await ddb.getSession(cookieHeader[SessionKey] as string))!
            expect(cookieHeader).toEqual(expect.objectContaining(sessionCookie()))
            expect(response).toEqual({
                isAuthorized: true,
                context: {
                    "id": newSession['session_id'],
                    'new_cookie': expect.any(String),
                    'access_token': newSession['access_token'],
                    'access': jwtDecode(newSession['access_token']),
                    'id_token': newSession['id_token'],
                    'profile': jwtDecode(newSession['id_token']),
                    'expires_at': newSession['expires_at']
                }
            })
        })
        it('saves new session and removes old from store', async () => {
            await authorize(sessionId)
            const sessionAfter = (await ddb.getSession(sessionId))!
            expect(sessionAfter).toBeNil()
        })
        describe('if token endpoint fails', () => {
            function setupFailure(code: 400 | 500) {
                httpMock.post.mockImplementation(async function () {
                    return {status: code}
                })
            }

            it('removes session if token endpoint respond 400', async () => {
                setupFailure(400)
                await authorize(sessionId)
                const newSession = await ddb.getSession(sessionId)
                expect(newSession).toBeNil()
            })
            it('returns 401 Unauthorized if token endpoint respond 400', async () => {
                setupFailure(400)
                const response = await authorize(sessionId)
                expect(response.isAuthorized).toBeFalsy()
            })
            it('throws if token endpoint respond with other error', async () => {
                setupFailure(500)
                await expect(authorize(sessionId)).rejects.toThrow()
            })
        })
    })

})

describe('Tokens endpoint', () => {
    it('returns tokens when called with valid session cookie', async () => {
        const sessionId = await startSession();
        const response = await httpReal.get(`${api.gateway.url}/user/session`, {
            headers: {'Cookie': `${SessionKey}=${sessionId}`},
        })
        console.log(response.data, response.headers)
        expect(response.status).toBe(200)
    }, 10000)

    it('returns 401 when called without session cookie', async () => {
        const response = await httpReal.get(`${api.gateway.url}/user/session`)
        expect(response.status).toBe(401)
    }, 10000)

    it('returns 403 when called with invalid session cookie', async () => {
        const response = await httpReal.get(`${api.gateway.url}/user/session`, {
            headers: {'Cookie': `${SessionKey}="Invalid session id"`},
        })
        expect(response.status).toBe(403)
    }, 10000)
})

/**
 * Populate process.env with values required by authorizer Lambda function
 */
function prepareAuthorizerEnvironment() {
    const outputs = resources()
    const {dynamodb, api, cognito, s3} = outputs as any
    const tokenEndpoint = `https://${cognito.userPoolDomain.domain}.auth.eu-south-1.amazoncognito.com/oauth2/token`;
    return {dynamodb, api, cognito, s3, tokenEndpoint};
}

/**
 * Trigger positive response in cognito mock
 */
const goodAuthorizationCode = "999"

/**
 * Trigger cognito mock to return broken token
 */
const brokenAuthorizationCode = "666"

/**
 * Triggers HTTP 500 error in the cognito mock.
 */
const triggerUnexpectedError = "500"

function parseSessionCookieHeader(header: string): { [p: string]: string | boolean } {
    const params = header.split(';')
    return params.reduce(function (cookie, kv) {
        const [key, value] = kv.split('=')
        cookie[key.trim()] = value != null ? decodeURIComponent(value.trim()) : true
        return cookie
    }, {} as any)
}

function parseSetCookieHeader(response: APIGatewayProxyStructuredResultV2): { [p: string]: string | boolean } {
    const header = response.headers!['Set-Cookie']! as string
    return parseSessionCookieHeader(header);
}

async function startSession() {
    const sample = {queryStringParameters: {'code': goodAuthorizationCode}}
    const response = await code({...event, ...sample}, awsContext);
    expect(response.statusCode).toBe(200)
    expect(response.body).toMatch(/meta http-equiv="refresh"/)
    expect(response.headers).toHaveProperty('Set-Cookie')
    const cookie = parseSetCookieHeader(response)
    expect(cookie).toHaveProperty(SessionKey)
    console.log('Started session ', cookie)
    return cookie[SessionKey] as string
}

const authorize = async function (sessionId: string) {
    return await cookie({...authEvent, headers: {'cookie': `${SessionKey}=${sessionId}`}}, awsContext)
}

function sessionCookie() {
    return {
        [SessionKey]: expect.toBeString(),
        'Expires': expect.toBeDateString(),
        'HttpOnly': expect.toBeBoolean(),
        'Secure': expect.toBeBoolean(),
    };
}
