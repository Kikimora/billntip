import 'jest-extended';
import {AxiosResponse} from "axios";
import _ from "lodash";
import http from "@src/http"
import {HttpRequestOptions, makeTestAuthorizer, makeTestHandler, prepare, resources} from "@app/test/util";
import {jwtDecode} from "jwt-decode";
import {code, cookie, Metrics} from "@src/authorizer";
import startAuthOperation from "@src/authorizer/operation";
import {TokenEndpointResponse} from "@src/authorizer/oidc_tokens";
import {TestGroup} from "@app/test/cognito";
import {delay} from "@app/util";

const httpMock = http as jest.Mocked<typeof http>;
const {default: httpReal} = jest.requireActual('@src/http');
const {api} = resources()

const cognitoMock = async function (url: string, data: any, config: any) {
    const {user, ctx: {tokenEndpoint}} = testContext()
    const request = [url, data.grant_type, data.code];
    if (_.isMatch(request, [tokenEndpoint, 'authorization_code', goodAuthorizationCode])) {
        return {
            status: 200,
            data: await user.login()
        }
    }
    if (_.isMatch(request, [tokenEndpoint, 'authorization_code', brokenAuthorizationCode])) {
        const tokens = await user.login()
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

const testContext = prepare('Once', {
    async before() {
        const group = await TestGroup.fetch()
        const [user, {sessions, tokens, cookies, ctx}] = await Promise.all([
            group.createUniqueUser(),
            startAuthOperation()
        ])
        httpMock.post.mockImplementation(cognitoMock)
        const SessionKey = ctx.cookieName
        return {group, user, sessions, tokens, cookies, ctx, SessionKey}
    },
    async after({user}) {
        await user?.delete()
        Metrics.stop()
    }
})

beforeEach(() => {
    //Restore mock implementation back to default as it might have changed by the previous test
    httpMock.post.mockImplementation(cognitoMock);
})

describe('OAuth callback validation', () => {
    it('requires `code` parameter in the query string', async () => {
        const samples: Partial<HttpRequestOptions>[] = [
            {},
            {query: {}},
            {query: {'code': ""}},
            {query: {'code': "123"}}
        ];
        for (let sample of samples) {
            const response = await codeHandler(sample);
            expect(response).toMatchObject({statusCode: 400})
        }
    })
    it('verifies token signature and throws', async () => {
        await expect(codeHandler({query: {'code': brokenAuthorizationCode}})).rejects.toThrow()
    })
    it('throws if token endpoint responds with unexpected error', async () => {
        await expect(codeHandler({query: {'code': triggerUnexpectedError}})).rejects.toThrow()
    })
})

describe('OAuth callback', () => {
    const authorize = prepare('Once', async () => {
        const response = await codeHandler({query: {'code': goodAuthorizationCode}});
        const context = testContext()
        const cookieHeader = response.headers!['Set-Cookie'];
        const expires = new Date(cookieHeader.match(/Expires=(.+?);/)[1])
        const cookie = context.cookies.load(cookieHeader)!
        const sessionId = context.sessions.sessionId(cookie)
        return {response, cookieHeader, sessionId, expires, ...context}
    })
    it('issues session cookie', async () => {
        const {expires, response} = authorize()
        expect(response.headers!['Set-Cookie']).toMatch(sessionCookieHeader())
        expect(expires).toBeAfter(new Date())
    })
    it('exchanges code for tokens', async () => {
        const {ctx} = authorize()
        expect(httpMock.post).toHaveBeenCalledWith(
            ctx.tokenEndpoint,
            expect.objectContaining({
                'grant_type': 'authorization_code',
                'code': goodAuthorizationCode
            }),
            expect.anything()
        )
    })
    it('creates session in dynamodb', async () => {
        const {sessionId, ctx, sessions} = authorize()
        const session = await sessions.fetch(sessionId)
        expect(session).toEqual(expect.objectContaining({
            'sessionId': sessionId,
            'userId': expect.toBeString(),
            'idToken': expect.toBeString(),
            'accessToken': expect.toBeString(),
            'refreshToken': expect.toBeString(),
            'accessExpiresAt': expect.toBePositive(),
            'refreshTokenExpiresAt': expect.toBePositive(),
            'sessionExpiresAt': expect.toBePositive(),
            'cachedTill': 0
        }))

        const now = Math.floor(Date.now() / 1000)
        expect(session?.refreshTokenExpiresAt).toBeCloseTo(now + ctx.refreshTokenTtl, -1)
        const refreshCall = _.last(httpMock.post.mock.results)?.value;
        const tokenResponse = await refreshCall as AxiosResponse<TokenEndpointResponse>
        expect(session?.accessExpiresAt).toBeCloseTo(now + tokenResponse.data.expires_in, -1)
    })
    it('issues HTML redirect to configured return url', async () => {
        const {response} = authorize()
        expect(response).toEqual(expect.objectContaining({
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
        const response = await cookieHandler({})
        expect(response.isAuthorized).toBeFalse()
    })
    it('requires session id in the Cookie header', async () => {
        const response = await cookieHandler({cookies: {'SomeCookie': '1'}})
        expect(response.isAuthorized).toBeFalse()
    })
    it('requires session to be present in dynamodb', async () => {
        const {SessionKey} = testContext()
        const response = await cookieHandler({cookies: {[SessionKey]: '1'}})
        expect(response.isAuthorized).toBeFalse()
    })
})

describe('Lambda authorizer', () => {

    const prepareSession = prepare('Each', {
        async before() {
            const context = testContext()
            const sessionId = await startSession();
            const session = await context.sessions.fetch(sessionId)
            return {sessionId, session: session!, ...context}
        },
        async after() {
        },
    })

    it('authorises request if no refresh needed', async () => {
        const {sessionId} = prepareSession()
        const response = await authorizeRequest(sessionId)
        expect(response.isAuthorized).toBeTrue()
    })

    it('bump timestamps', async () => {
        const {sessionId, session, sessions} = prepareSession()
        await delay(1000)
        await authorizeRequest(session.sessionId)
        const after = (await sessions.fetch(sessionId))!
        expect(after.sessionExpiresAt).toBeGreaterThan(session.sessionExpiresAt)
        expect(after.cachedTill).toBeGreaterThan(session.cachedTill)
        expect(after.updatedAt).toBeGreaterThan(session.updatedAt)
    })

    it('return new session context', async () => {
        const {sessionId, sessions} = prepareSession()
        const response = await authorizeRequest(sessionId)
        const session = (await sessions.fetch(sessionId))!
        expect(response).toEqual({
            isAuthorized: true,
            context: {
                "id": session.sessionId,
                'access_token': session.accessToken,
                'access_token_json': jwtDecode(session.accessToken),
                'id_token': session.idToken,
                'id_token_json': jwtDecode(session.idToken),
                'access_token_expires_at': session.accessExpiresAt,
                'session_expires_at': session.sessionExpiresAt,
                'updated_at': session.updatedAt
            }
        })
    })

    it.each([
        ["session", {sessionExpiresAt: 1}],
        ["refresh token", {refreshTokenExpiresAt: 1}],
    ])("fails if %s expired", async (_, update) => {
        const {sessionId, session} = prepareSession()
        await session!.update(update).applyUpdates().save()
        const response = await authorizeRequest(sessionId)
        expect(response.isAuthorized).toBeFalse()
    })

    describe('refresh tokens', () => {

        const expireSession = prepare('Each', async function () {
            let {session} = prepareSession()
            session = await session.update({accessExpiresAt: 1}).applyUpdates().save()
            return {...prepareSession(), session}
        })

        it('executes refresh_token grant with saved refresh token', async () => {
            const {sessionId, session, ctx: {tokenEndpoint}} = expireSession()
            await authorizeRequest(sessionId)
            expect(httpMock.post).toHaveBeenCalledWith(
                tokenEndpoint,
                expect.objectContaining({
                    'grant_type': 'refresh_token',
                    'refresh_token': session.refreshToken
                }),
                expect.anything()
            )
        })

        it('updates tokens', async () => {
            const {sessionId, sessions, session} = expireSession()
            await authorizeRequest(sessionId)
            const after = (await sessions.fetch(sessionId))!
            expect(after.accessToken).not.toEqual(session.accessToken)
            expect(after.idToken).not.toEqual(session.idToken)
            expect(after.accessExpiresAt).toBeGreaterThanOrEqual(session.accessExpiresAt)
        })

        describe('if token endpoint fails', () => {

            function setupFailure(code: 400 | 500) {
                httpMock.post.mockImplementation(async function () {
                    return {status: code}
                })
            }

            it('removes session if token endpoint respond 400', async () => {
                const {sessionId, sessions} = prepareSession()
                setupFailure(400)
                await authorizeRequest(sessionId)
                const newSession = await sessions.fetch(sessionId)
                expect(newSession).toBeNil()
            })
            it('returns 401 Unauthorized if token endpoint respond 400', async () => {
                const {sessionId} = prepareSession()
                setupFailure(400)
                const response = await authorizeRequest(sessionId)
                expect(response.isAuthorized).toBeFalsy()
            })
            it('throws if token endpoint respond with other error', async () => {
                const {sessionId} = prepareSession()
                setupFailure(500)
                await expect(authorizeRequest(sessionId)).rejects.toThrow()
            })
        })
    })
})

describe('Tokens endpoint', () => {
    it('returns tokens when called with valid session cookie', async () => {
        const {SessionKey} = testContext()
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

    it('returns 401 when called with invalid session cookie', async () => {
        const {SessionKey} = testContext()
        const response = await httpReal.get(`${api.gateway.url}/user/session`, {
            headers: {'Cookie': `${SessionKey}="Invalid session id"`},
        })
        expect(response.status).toBe(401)
    }, 10000)
})

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

async function startSession() {
    const {cookies, sessions} = testContext()
    const response = await codeHandler({
        query: {code: goodAuthorizationCode}
    });
    expect(response.statusCode).toBe(200)
    expect(response.body).toMatch(/meta http-equiv="refresh"/)
    expect(response.headers).toHaveProperty('Set-Cookie')
    const cookie = cookies.load(response.headers['Set-Cookie'])
    console.log('Started session ', cookie?.value)
    return sessions.sessionId(cookie!)
}

const cookieHandler = makeTestAuthorizer(cookie, {
    routeKey: "GET /some/random/endpoint",
})

const authorizeRequest = async function (sessionId: string) {
    const {SessionKey} = testContext()
    return await cookieHandler({cookies: {[SessionKey]: sessionId}})
}

const codeHandler = makeTestHandler(code, {
    routeKey: "GET /auth/cognito/idpresponse"
})

function sessionCookieHeader() {
    const {SessionKey} = testContext()
    return new RegExp(SessionKey + "=.*; Path=\/; Expires=.*; HttpOnly; Secure; Partitioned; SameSite=None")
}
