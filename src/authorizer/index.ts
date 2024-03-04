import {
    APIGatewayAuthorizerEvent,
    APIGatewayProxyEventV2,
    APIGatewaySimpleAuthorizerWithContextResult,
    APIGatewayProxyStructuredResultV2, APIGatewayProxyEventV2WithLambdaAuthorizer, Context
} from "aws-lambda";
import {accessTokenVerifier, idTokenVerifier, startAuthOperation} from "./module";
import {AuthorizerContext} from "./ctx";
import {Tracer} from '../diagnostics'

const Unauthorized = {isAuthorized: false, context: {}}
const BadRequest = {statusCode: 400, body: JSON.stringify({'error': 'Invalid request parameters.'})}
type AuthResult = APIGatewaySimpleAuthorizerWithContextResult<any>

type AuthorizerHooks = {
    cookieAuthorizerStart?: () => Promise<void>,
    cookieAuthorizerRefresh?: () => Promise<void>;
    cookieAuthorizerNewSession?: () => Promise<void>;
    cookieAuthorizerFinish?: () => Promise<void>,
}
export const hooks: AuthorizerHooks = {}
const authTracer = new Tracer("auth")

// noinspection JSUnusedGlobalSymbols
/**
 * Authorize request based on a cookie value. The authorizer performs following steps:
 * 1. Check cookies for a valid session identifier.
 * 2. Find corresponding session data with OIDC refresh and access tokens.
 * 3. If access token is about to expire or expired then refresh the session using OpenId token endpoint.
 * 4. If refresh token changed then request API GW integration to issue a new cookie by setting `context.new_cookie` value.
 * 5. Populate `context.access_token` and `context.id_token` values. These variables can be accessed by the endpoint handler.
 *
 * **Important!** Authorizer requires proper API GW configuration:
 * 1. API GW Integration on a route protected with authorizer MUST map `header.Set-Cookie` to `$context.authorizer.new_cookie`
 * 2. Authorizer identity source MUST be `$request.header.Cookie`.
 *
 * Session data contains access token issued by the OIDC server. This token controls access to the OIDC server API for
 * things like profile access, password change, etc. Access token refresh happens if
 * `now >= access token expiration - authorizer cache ttl - 1 min`. In other words if we expect that next authorizer call might
 * happen after access token expires. Note how this condition guarantees that `context.access_token` contains valid
 * access token at all times. This is because authorizer cache always expires before the token and authorizer called
 * before request handler (giving it a chance to populate `context.access_token` with a fresh value). If `cache ttl` is 0
 * meaning there is no cache and authorizer called on every request then access token refresh happens when token is about to expire.
 *
 * If refresh token changes then authorizer issues a new cookie and immediately deletes previous cookie from the session store.
 * Next request with a new cookie which triggers authorizer call again (because of how identity source configured).
 * These two requests would leave two entries in the authorizer cache:
 * 1. Old Cookie -> { new_cookie:"...", access_token:"new token", id_token:"new token", refresh_token:"new token" }
 * 2. New Cookie -> { access_token:"new token", id_token:"new token", refresh_token:"new token" }
 * If client keeps using old cookie then every response will have Set-Cookie header until authorizer cache entry is not
 * expired. After if expires client with old cookie would get 401 Unauthorized or 403 Forbidden.
 *
 */
export async function cookie(event: APIGatewayAuthorizerEvent, context: Context): Promise<AuthResult> {
    const tracer = authTracer.startSession("cookie", event)
    try {
        const {SessionCookie, SessionData, OidcTokens} = await startAuthOperation(context.awsRequestId)
        switch (event.type) {
            case "REQUEST": {
                const cookieHeader = event.headers?.cookie
                if (cookieHeader == null) {
                    tracer.info("no cookie header")
                    return Unauthorized
                }
                const sessionCookie = SessionCookie.load(cookieHeader)
                if (sessionCookie == null) {
                    tracer.info("cookie header present, but invalid", {cookieHeader})
                    return Unauthorized
                }
                const session = await SessionData.loadAndLock(sessionCookie.id)
                if (session == null) {
                    tracer.info("cannot load session", {sessionId: sessionCookie.id})
                    return Unauthorized
                }
                tracer.info("start", {session: session.info})
                let response: AuthResult = {isAuthorized: false, context: {}}
                try {
                    if (hooks.cookieAuthorizerStart) {
                        await hooks.cookieAuthorizerStart()
                    }
                    session.notifyCacheTtlExtension()
                    if (session.isTimeToRefresh) {
                        tracer.info("tokens expired, refreshing using refresh token", {session: session.info})
                        if (hooks.cookieAuthorizerRefresh) {
                            await hooks.cookieAuthorizerRefresh()
                        }
                        const tokens = await OidcTokens.refresh(session.refreshToken)
                        if (tokens == null) {
                            tracer.info("OIDC server refused to refresh tokens")
                            await session.remove();
                            return Unauthorized
                        }

                        const updatedSession = session.withTokens(tokens)
                        if (updatedSession.isTimeToRefresh) {
                            //It is a problem if after refresh session still can expire while being cached.
                            const error = new Error("Configuration issue: API Gateway will cache tokens for over their lifetime.")
                            // noinspection ExceptionCaughtLocallyJS
                            throw tracer.addContext(error, {
                                session: session.info,
                                updatedSession: updatedSession.info
                            })
                        }

                        if (updatedSession.isRefreshTokenRotated) {
                            tracer.info("OIDC server rotated refresh token", {session: updatedSession.info})
                            if (hooks.cookieAuthorizerNewSession) {
                                await hooks.cookieAuthorizerNewSession()
                            }
                            const newCookie = updatedSession.makeCookie()
                            await updatedSession.create()
                            await session.remove()

                            response = {
                                isAuthorized: true,
                                context: {
                                    'new_cookie': newCookie.makeHeaderValue(),
                                    ...updatedSession.context()
                                }
                            }
                        } else {
                            tracer.info("OIDC server refreshed tokens")
                            await updatedSession.save()
                            response = {
                                isAuthorized: true,
                                context: {
                                    ...updatedSession.context()
                                }
                            }
                        }
                    } else {
                        tracer.info("tokens are valid (not expired)")
                        response = {
                            isAuthorized: true,
                            context: {
                                ...session.context()
                            }
                        }
                    }
                    tracer.info("done", {...response})
                    return response
                } catch (e: any) {
                    tracer.error(e, {session: session.info, sessionCookie})
                    throw e
                } finally {
                    tracer.info("cleanup")
                    await session.release()
                    if (hooks.cookieAuthorizerFinish) {
                        await hooks.cookieAuthorizerFinish()
                    }
                }
            }
            default:
                return Unauthorized
        }
    } finally {
        tracer.done()
    }
}

/**
 * Handle authorization code grant callback. The callback is called by OIDC server after it verified user credentials.
 * The 'code' parameter contains one time code to get id, access and refresh tokens.
 */
export async function code(event: APIGatewayProxyEventV2, context: Context): Promise<APIGatewayProxyStructuredResultV2> {
    const tracer = authTracer.startSession("code", event)

    try {
        const {SessionData, OidcTokens, env} = await startAuthOperation(context.awsRequestId)
        //TODO support OAuth PKCE for better security
        const code = event.queryStringParameters?.['code'] ?? ""
        const callbackUrl = `https://${event.requestContext.domainName}${event.rawPath}`
        const tokens = await OidcTokens.authorisationCode(code, callbackUrl)
        if (tokens == null) return BadRequest
        await Promise.all([tokens.verifyIdToken(), tokens.verifyAccessToken()])
        const session = SessionData.fromTokens(tokens)
        const cookie = session.makeCookie()
        await session.create()
        tracer.info("new session", {
            sessionId: session.sessionId,
            refreshBefore: session.accessExpiresAt,
            expiresAt: session.sessionExpiresAt
        })
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html',
                'Set-Cookie': cookie.makeHeaderValue()
            },
            //Use HTML redirect to allow SameSite=Strict cookies.
            //Using normal HTTP 302 Redirect code would only work with SameSite=Lax cookies
            //https://stackoverflow.com/questions/42216700/how-can-i-redirect-after-oauth2-with-samesite-strict-and-still-get-my-cookies
            body: `
    <html lang="en">
        <head>
        <meta http-equiv="refresh" content="0;URL='${env.postAuthRedirectUrl}'"/>
        <title>Bill & Tip</title>
        </head>
        <body><p>Moved to <a href="${env.postAuthRedirectUrl}">${env.postAuthRedirectUrl}</a>.</p></body>
    </html>`
        }
    } catch (e) {
        tracer.error(e)
        throw e
    } finally {
        tracer.done()
    }
}

export const tokens = async function (event: APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>): Promise<APIGatewayProxyStructuredResultV2> {
    const tracer = authTracer.startSession("tokens", event)

    try {
        const authContext = event.requestContext.authorizer.lambda
        if (authContext == null) {
            tracer.info("request context does not have lambda authorizer data")
            return {
                statusCode: 401,
                body: ""
            }
        }
        await Promise.all([
            idTokenVerifier.verify(authContext.id_token),
            accessTokenVerifier.verify(authContext.access_token)
        ])
        return {
            statusCode: 200,
            body: JSON.stringify({
                access_token: authContext.access_token,
                id_token: authContext.id_token,
                expires_at: authContext.expires_at
            })
        }
    } catch (e) {
        tracer.error(e)
        throw e
    } finally {
        tracer.done()
    }
}
