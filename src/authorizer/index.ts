import {
    APIGatewayAuthorizerEvent,
    APIGatewaySimpleAuthorizerWithContextResult,
    APIGatewayProxyStructuredResultV2
} from "aws-lambda";
import {Env, initModuleVariables, Metrics} from "./ctx";
import {configure, findErrorContext, Tracer} from '@app/diagnostics'
import SessionData, {SessionContext} from "./session";
import OidcTokens from "./oidc_tokens";
import SessionCookie from "./cookie";
import {pipeline} from "@app/lambda";

const Unauthorized = {isAuthorized: false, context: undefined}
const BadRequest = {statusCode: 400, body: JSON.stringify({'error': 'Invalid request parameters.'})}
type AuthContext = (SessionContext & { new_cookie?: string }) | undefined;
type AuthResult = APIGatewaySimpleAuthorizerWithContextResult<AuthContext>

type AuthorizerHooks = {
    cookieAuthorizerStart?: () => Promise<void>,
    cookieAuthorizerRefresh?: () => Promise<void>;
    cookieAuthorizerFinish?: () => Promise<void>,
}
export const hooks: AuthorizerHooks = {}
configure({
    triggers: {
        info: true, error: true, warn: true, request: true
    }
})
const tracer = new Tracer("auth")

/**
 * Authorize request based on a cookie value. The authorizer performs following steps:
 * 1. Check cookies for a valid session identifier.
 * 2. Find corresponding session data with OIDC refresh and access tokens.
 * 3. If access token is about to expire or expired then refresh the session using OpenId token endpoint and rotate cookie.
 * 4. Populate `context.access_token` and `context.id_token` values. These variables can be accessed by the endpoint handler.
 *
 * **Important!** Authorizer requires proper API GW configuration:
 * 1. API GW Integration on a route protected with authorizer MUST map `header.Set-Cookie` to `$context.authorizer.new_cookie`
 * 2. Authorizer identity source MUST be `$request.header.Cookie`.
 *
 * Session data contains access token issued by the OIDC server. This token controls access to the OIDC server API for
 * things like profile access, password change, etc. Access token refresh happens if
 * `access token expiration < now + authorizer cache ttl - 10 sec`. In other words it is possible that cache would hold expired tokens.
 * Note how this condition guarantees that `context.access_token` contains valid
 * access token at all times. This is because authorizer cache always expires before the token and authorizer called
 * before request handler (giving it a chance to populate `context.access_token` with a fresh value). If `cache ttl` is 0
 * meaning there is no cache and authorizer called on every request then access token refresh happens when token is about to expire.
 *
 * Together with token refresh authorizer rotates cookie. Next request with a new cookie which triggers authorizer call
 * again (because of how identity source configured). These two requests would leave two entries in the authorizer cache:
 * 1. Old Cookie -> { new_cookie:"...", access_token:"new token", id_token:"new token", refresh_token:"new token" }
 * 2. New Cookie -> { access_token:"new token", id_token:"new token", refresh_token:"new token" }
 * If client keeps using old cookie then every response will have Set-Cookie header until authorizer cache entry is not
 * expired. After it expires client with old cookie would get 401 Unauthorized or 403 Forbidden.
 *
 */

export const cookie = pipeline<APIGatewayAuthorizerEvent>()
    .traceRequest({tracer, tag: "cookie"})
    .done(async function (event, context): Promise<AuthResult> {
        const {tracer} = event
        const {now} = await initModuleVariables(context.awsRequestId)
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
                if (session == null || session.refreshTokenExpiresAt < now) {
                    tracer.info("session not found or expired", {sessionId: sessionCookie.id, ...session?.info})
                    return Unauthorized
                }
                tracer.info("start", {session: session.info})
                try {
                    return await authenticateSession(session)
                } catch (e: any) {
                    throw tracer.addContext(e, {session: session.info, sessionCookie})
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

        async function authenticateSession(session: SessionData) {
            let response: AuthResult = {isAuthorized: false, context: undefined}
            if (hooks.cookieAuthorizerStart) {
                await hooks.cookieAuthorizerStart()
            }
            session.updateCacheTtl()
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

                const newSession = session.withTokens(tokens)
                //Fail if after refresh the session still can expire while being cached.
                if (newSession.isTimeToRefresh) {
                    const error = new Error("Configuration issue: API Gateway will cache tokens for over their lifetime.")
                    throw tracer.addContext(error, {updatedSession: newSession.info})
                }

                tracer.info("session refreshed", {session: newSession.info})
                const newCookie = newSession.makeCookie()
                await Promise.all([newSession.create(), session.remove()])
                response = {
                    isAuthorized: true,
                    context: {
                        new_cookie: newCookie.makeHeaderValue(),
                        ...newSession.context()
                    }
                }
                tracer.info("done", {session: newSession.info, sessionCookie: newCookie})
            } else {
                tracer.info("tokens are valid (not expired)")
                response = {
                    isAuthorized: true,
                    context: {
                        ...session.context()
                    }
                }
                tracer.info("done", {session: session.info})
            }
            return response
        }
    })

/**
 * Handle authorization code grant callback. The callback is called by OIDC server after it verified user credentials.
 * The 'code' parameter contains one time code to get id, access and refresh tokens.
 */
export const code = pipeline()
    .traceRequest({tracer, tag: "code"})
    .done(async function (event, context): Promise<Promise<APIGatewayProxyStructuredResultV2>> {
        Metrics.setDimensions({functionVersion: context.functionVersion})
        const {tracer} = event
        await initModuleVariables(context.awsRequestId)
        //TODO support OAuth PKCE for better security
        const code = event.queryStringParameters?.['code'] ?? ""
        const callbackUrl = `https://${event.requestContext.domainName}${event.rawPath}`
        const tokens = await OidcTokens.authorisationCode(code, callbackUrl)
        if (tokens == null) return BadRequest
        const start = performance.now()
        await Promise.all([tokens.verifyIdToken(), tokens.verifyAccessToken()])
        Metrics.tokenVerificationLatency(performance.now() - start)
        const session = SessionData.createWithTokens(tokens)
        const cookie = session.makeCookie()
        await session.create()
        tracer.info("new session", {
            sessionId: session.sessionId,
            refreshBefore: session.accessExpiresAt,
            expiresAt: session.refreshTokenExpiresAt
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
        <meta http-equiv="refresh" content="0;URL='${Env.postAuthRedirectUrl}'"/>
        <title>Bill & Tip</title>
        </head>
        <body><p>Moved to <a href="${Env.postAuthRedirectUrl}">${Env.postAuthRedirectUrl}</a>.</p></body>
    </html>`
        }
    })

export const tokens = pipeline()
    .do(async function (e, context) {
        try {
            return await this.next(e, context)
        } catch (e) {
            const ctx = findErrorContext(e, "requireLambdaAuth")
            if (ctx !== undefined) {
                return {
                    statusCode: 401,
                    body: ""
                }
            }
            throw e
        }
    })
    .traceRequest({tracer, tag: "tokens"})
    .requireLambdaAuth<SessionContext>()
    .done(async function (event): Promise<APIGatewayProxyStructuredResultV2> {
            const authContext = event.requestContext.authorizer.lambda
            return {
                statusCode: 200,
                body: JSON.stringify({
                    access_token: authContext.access_token,
                    id_token: authContext.id_token,
                    profile: authContext.profile,
                    access: authContext.access,
                    expires_at: authContext.expires_at
                })
            }
        }
    )