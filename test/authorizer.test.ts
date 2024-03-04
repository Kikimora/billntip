import {TokenEndpointResponse} from "../src/authorizer/module";

jest.mock('../src/http');

import 'jest-extended';
import * as fs from "fs";
import * as upath from "upath";
import {APIGatewayAuthorizerEvent, APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2} from "aws-lambda";
import _ from "lodash";
import http from "../src/http"
import {init as cognitoInit, TestGroup, TestUser} from "./cognito"
import {init as dynamoDbInit} from './dynamodb'

const httpMock = http as jest.Mocked<typeof http>;
const {default: httpReal} = jest.requireActual('../src/http');
const SessionKey = 'JSESSIONID';
const {tokenEndpoint, userPoolId, userPoolClientId, sessionTable, apiUrl} = prepareAuthorizerEnvironment();
import {code, tokens, cookie, hooks} from "../src/authorizer";
import {AxiosResponse} from "axios";
import {useVariables} from "../src/authorizer/ctx";

const ddb = dynamoDbInit(sessionTable)

const event: APIGatewayProxyEventV2 = {
    routeKey: "",
    rawPath: "",
    headers: {},
    rawQueryString: "",
    requestContext: {} as any,
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
        'Cookie': 'JSESSIONID=abc.xyz'
    },
    multiValueHeaders: {},
    pathParameters: null,
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    requestContext: {} as any,
    stageVariables: null
}

const testContext: {
    group?: TestGroup,
    user?: TestUser
} = {}

beforeAll(async () => {
    const testCognitoModule = await cognitoInit(userPoolId, userPoolClientId)
    testContext.group = await testCognitoModule.loadTestGroup()
    testContext.user = await testContext.group.createUniqueUser()
    httpMock.post.mockImplementation(cognitoMock);
})

afterAll(async () => {
    await testContext.user?.delete()
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
            const response = await code({...event, ...sample});
            expect(response).toMatchObject({statusCode: 400})
        }
    })
    it('verifies token signature and throws', async () => {
        const sample = {queryStringParameters: {'code': brokenAuthorizationCode}}
        await expect(code({...event, ...sample})).rejects.toThrow()
    })
    it('throws if token endpoint responds with unexpected error', async () => {
        const sample = {queryStringParameters: {'code': triggerUnexpectedError}}
        await expect(code({...event, ...sample})).rejects.toThrow()
    })
})

describe('OAuth callback', () => {
    let response, cookie: any
    beforeAll(async () => {
        const sample = {queryStringParameters: {'code': goodAuthorizationCode}}
        response = await code({...event, ...sample});
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
        const now = Math.floor(Date.now() / 1000)
        const lastPostResult = _.last(httpMock.post.mock.results)?.value;
        const tokenResponse = await lastPostResult as AxiosResponse<TokenEndpointResponse>
        const sessionId = cookie[SessionKey]
        const session = await ddb.getSession(sessionId)
        expect(session).toEqual(expect.objectContaining({
            'session_id': sessionId,
            'id_token': expect.toBeString(),
            'access_token': expect.toBeString(),
            'refresh_token': expect.toBeString(),
            'salt': expect.toBeString(),
            'expires_at': expect.toBePositive(),
            'session_expires_at': expect.toBePositive(),
        }))
        expect(session!['lock']).toBeUndefined()
        const sessionExpiresAt = session!['session_expires_at']
        const {refreshTokenTtl} = useVariables()
        expect(sessionExpiresAt).toBeCloseTo(now + refreshTokenTtl, -1)
        const expiresAt = session!['expires_at']
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
        const response = await cookie({...authEvent, headers: {}})
        expect(response.isAuthorized).toBeFalse()
    })
    it('requires session id in the Cookie header', async () => {
        const response = await cookie({...authEvent, headers: {'Cookie': 'SomeCookie=1'}})
        expect(response.isAuthorized).toBeFalse()
    })
    it('requires session to be present in dynamodb', async () => {
        const response = await cookie({...authEvent, headers: {'Cookie': `${SessionKey}=1`}})
        expect(response.isAuthorized).toBeFalse()
    })
})

describe('Lambda authorizer', () => {
    let sessionId: string
    beforeEach(async () => {
        const now = Math.floor(Date.now()) / 1000;
        sessionId = await startSession();
        hooks.cookieAuthorizerStart = jest.fn().mockImplementation(async function () {
            //Verify session locked before business logic starts
            const session = await ddb.getSession(sessionId)
            expect(session).toEqual(expect.objectContaining({
                lock: expect.any(String),
                lock_till: expect.any(Number)
            }))
            const lockTill = session!['lock_till'] as number
            expect(lockTill).toBeCloseTo(now + 10, -1)
        })
        hooks.cookieAuthorizerRefresh = jest.fn()
        hooks.cookieAuthorizerNewSession = jest.fn()
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
        delete hooks.cookieAuthorizerNewSession
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

    describe('refreshes tokens using OAuth token endpoint', () => {
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
            await authorize(sessionId)
            const sessionAfter = (await ddb.getSession(sessionId))!
            expect(hooks.cookieAuthorizerRefresh).toHaveBeenCalled()
            expect(sessionAfter['access_token']).not.toBe(sessionBefore['access_token'])
            expect(sessionAfter['id_token']).not.toBe(sessionBefore['id_token'])
            expect(sessionAfter['refresh_token']).toBe(sessionBefore['refresh_token'])
            expect(sessionAfter['expires_at']).toBeGreaterThan(sessionBefore['expires_at'])
            expect(sessionAfter['session_expires_at']).toBe(sessionBefore['session_expires_at'])
        })

        describe('if refresh token rotate', () => {
            beforeEach(async () => {
                httpMock.post.mockImplementation(async function () {
                    return {
                        status: 200,
                        data: {
                            access_token: 'ACCESS TOKEN',
                            id_token: 'ID TOKEN',
                            expires_in: 3600,
                            refresh_token: 'NEW REFRESH TOKEN'
                        }
                    }
                })
            })
            it('issues new session cookie and tokens', async () => {
                const response = await authorize(sessionId)
                const cookieHeader = parseSessionCookieHeader(response.context.new_cookie)
                const newSession = (await ddb.getSession(cookieHeader[SessionKey] as string))!

                expect(cookieHeader).toEqual(expect.objectContaining(sessionCookie()))
                expect(response).toEqual(expect.objectContaining({
                    isAuthorized: true,
                    context: {
                        'new_cookie': expect.any(String),
                        'access_token': newSession['access_token'],
                        'id_token': newSession['id_token'],
                        'expires_at': newSession['expires_at']
                    }
                }))
            })
            it('saves new session and removes old from store', async () => {
                const response = await authorize(sessionId)
                const cookieHeader = parseSessionCookieHeader(response.context.new_cookie);
                const sessionAfter = (await ddb.getSession(sessionId))!
                const newSession = (await ddb.getSession(cookieHeader[SessionKey] as string))!
                expect(sessionAfter).toBeNil()
                expect(newSession['refresh_token']).toEqual('NEW REFRESH TOKEN')
            })
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
        console.log(`curl -v -H 'Cookie: ${SessionKey}=${sessionId}' 'https://nyly887aja.execute-api.eu-south-1.amazonaws.com/dev/auth/tokens' | jq`)
        // const response = await handler({
        //     ...event,
        //     ...{
        //         pathParameters: {'resource': 'tokens'},
        //         cookies: [`${SessionKey}=${sessionId}`],
        //         requestContext: {
        //             'authorizer': {'access_token': 'some token'}
        //         }
        //     }
        // });
        // expect(response).toEqual(expect.objectContaining({
        //     statusCode: 200,
        //     body: expect.toBeString()
        // }))
        // const body = JSON.parse(response.body!)
        // expect(body).toEqual(expect.objectContaining({
        //     access_token: expect.toBeString(),
        //     id_token: expect.toBeString(),
        //     expires_at: expect.toBeNumber()
        // }))
        // expect(body.expires_at).toBeGreaterThan(Date.now() / 1000)
    })

    it('returns 401 when called without session cookie', async () => {
        const response = await http.get(`${apiUrl}/auth/tokens`)
        expect(response.status).toBe(401)
    })

    it('returns 401 when called with invalid session cookie', async () => {
        const response = await http.get(`${apiUrl}/auth/tokens`, {headers: {[SessionKey]: "Invalid cookie"}})
        expect(response.status).toBe(401)
    })
})

/**
 * Populate process.env with values required by authorizer Lambda function
 */
function prepareAuthorizerEnvironment() {
    const o = upath.join(__dirname, "..", "out", "outputs.json")
    const outputs = JSON.parse(fs.readFileSync(o).toString("utf-8"))
    const {sessionTable, userPoolId, userPoolClientId, userPoolDomain, apiUrl} = outputs as any
    const tokenEndpoint = `https://${userPoolDomain}.auth.eu-south-1.amazoncognito.com/oauth2/token`;
    const oathIssuer = `https://cognito-idp.eu-south-1.amazonaws.com/${userPoolId}`;
    Object.assign(process.env, {
        COOKIE_NAME: SessionKey,
        SESSION_TABLE: sessionTable,
        USER_POOL_ID: userPoolId,
        OAUTH_CLIENT_ID: userPoolClientId, //user pool client id
        OAUTH_ISSUER: oathIssuer,
        OAUTH_TOKEN_ENDPOINT: tokenEndpoint,
        POST_AUTH_REDIRECT_URL: "https://localhost",
        AWS_REGION: "eu-south-1"
    })
    return {tokenEndpoint, userPoolId, userPoolClientId, oathIssuer, sessionTable, apiUrl};
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
    const response = await code({...event, ...sample});
    expect(response.statusCode).toBe(200)
    expect(response.body).toMatch(/meta http-equiv="refresh"/)
    expect(response.headers).toHaveProperty('Set-Cookie')
    const cookie = parseSetCookieHeader(response)
    expect(cookie).toHaveProperty(SessionKey)
    console.log('Started session ', cookie)
    return cookie[SessionKey] as string
}

const authorize = async function (sessionId: string) {
    return await cookie({...authEvent, headers: {'cookie': `${SessionKey}=${sessionId}`}})
}

function sessionCookie() {
    return {
        [SessionKey]: expect.toBeString(),
        'Expires': expect.toBeDateString(),
        'HttpOnly': expect.toBeBoolean(),
        'Secure': expect.toBeBoolean(),
    };
}
