import {
    APIGatewayAuthorizerEvent,
    APIGatewaySimpleAuthorizerWithContextResult,
    APIGatewayProxyStructuredResultV2
} from "aws-lambda";
import diagnostics, {EMF, errorWithContext, findErrorContext, Tracer} from '@app/diagnostics'
import {pipeline} from "@app/lambda";
import startAuthOperation, {SessionContext, SessionContextSchema} from "./operation";

//This response triggers 401 Unauthorized instead of default 403 Forbidden.
//This is not documented and was mentioned here - https://stackoverflow.com/a/73028814/2766648
const Unauthorized = {isAuthorized: false, errorMessage: "Unauthorized"}
const BadRequest = {statusCode: 400, body: JSON.stringify({'error': 'Invalid request parameters.'})}
type AuthContext = SessionContext | undefined;
type AuthResult = APIGatewaySimpleAuthorizerWithContextResult<AuthContext> | typeof Unauthorized

diagnostics({
    triggers: {
        info: true, error: true, warn: true, request: true
    }
})

export const AuthTracer = new Tracer("authorizer")
export const Metrics = EMF.namespace("authorizer")
    .dimensions("functionVersion")
    .metric("tokenVerificationLatency", {units: "Milliseconds"})
    .startReporter()

/**
 * Authorize request based on a cookie value. The authorizer performs following steps:
 * 1. Check cookies for a valid session identifier.
 * 2. Find corresponding session data with OIDC refresh and access tokens.
 * 3. Verifies that session has not expired.
 * 3. If associated access token is about to expire or expired then refresh the session using OIDC token endpoint.
 * 4. Populate `context.access_token` and `context.id_token` values. These variables can be accessed by the endpoint handler.
 *
 * Note: authorizer does not issue new cookies, nor it extends cookie lifetime. However, it does return unauthorized if
 * session is expired. This happens when cookie is present but, it was not used for the inactivity period.
 *
 * Usually you would want to issue cookies with expiration equal to the refresh token expiration (aka require login period).
 */
export const cookie = pipeline<APIGatewayAuthorizerEvent>()
    .traceRequest({tracer: AuthTracer, tag: "cookie"})
    .done(async function (event, context): Promise<AuthResult> {
        const {tracer} = event

        const {tokens: oidc, sessions, cookies} = await startAuthOperation(context.awsRequestId)
        switch (event.type) {
            case "REQUEST": {
                const cookieHeader = event.headers?.cookie
                if (cookieHeader == null) {
                    tracer.info("no cookie header")
                    return Unauthorized
                }
                const sessionCookie = cookies.load(cookieHeader)
                if (sessionCookie == null) {
                    tracer.info("cookie header present, but invalid", {cookieHeader})
                    return Unauthorized
                }
                const session = await sessions.fetch(sessionCookie)
                if (session === null) {
                    tracer.info("session not found", {sessionId: sessionCookie.value})
                    return Unauthorized
                }
                if (session.isSessionExpired) {
                    tracer.info("session expired", {...session.info})
                    return Unauthorized
                }

                try {
                    tracer.info("start", {session: session.info})

                    session.bump()

                    if (session.isTimeToRefreshTokens) {
                        tracer.info("tokens expired, refreshing using refresh token", {session: session.info})

                        const tokens = await oidc.refresh(session.refreshToken)
                        if (tokens == null) {
                            tracer.warn("OIDC server refused to refresh tokens")
                            await session.remove();
                            return Unauthorized
                        }

                        session.updateTokens(tokens)
                    }

                    const newSession = session.applyUpdates()
                    //Fail if after refresh the session still can expire while being cached.
                    if (newSession.isTimeToRefreshTokens) {
                        tracer.warn("access token is about to expire right after refresh", {updatedSession: newSession.info})
                        return Unauthorized
                    }
                    await newSession.save()
                    tracer.info("done", {session: newSession.info})
                    return {
                        isAuthorized: true,
                        context: {
                            ...newSession.context()
                        }
                    }
                } catch (e: any) {
                    throw errorWithContext(e, tracer.tag, {session: session.info, sessionCookie})
                } finally {
                    tracer.info("cleanup")
                    await session.release()
                }
            }
            default:
                return Unauthorized
        }
    })

/**
 * Handle authorization code grant callback. The callback is called by OIDC server after it verified user credentials.
 * The 'code' parameter contains one time code to get id, access and refresh tokens.
 */
export const code = pipeline()
    .traceRequest({tracer: AuthTracer, tag: "code"})
    .done(async function (event, context): Promise<Promise<APIGatewayProxyStructuredResultV2>> {
        Metrics.setDimensions({functionVersion: context.functionVersion})
        const {tracer} = event
        const {ctx: {postAuthRedirectUrl}, tokens: oidc, sessions} = await startAuthOperation(context.awsRequestId)
        //TODO support OAuth PKCE for better security
        const code = event.queryStringParameters?.['code'] ?? ""
        const callbackUrl = `https://${event.requestContext.domainName}${event.rawPath}`
        const tokens = await oidc.authorisationCode(code, callbackUrl)
        if (tokens == null) return BadRequest
        const start = performance.now()
        await Promise.all([tokens.verifyIdToken(), tokens.verifyAccessToken()])
        Metrics.tokenVerificationLatency(performance.now() - start)
        const session = await sessions.createWithTokens(tokens)
        const cookie = session.newSessionCookie()
        await session.save()
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
        <meta http-equiv="refresh" content="0;URL='${postAuthRedirectUrl}'"/>
        <title>Bill & Tip</title>
        </head>
        <body><p>Moved to <a href="${postAuthRedirectUrl}">${postAuthRedirectUrl}</a>.</p></body>
    </html>`
        }
    })

export const tokens = pipeline()
    .traceRequest({tracer: AuthTracer, tag: "tokens"})
    .handleErrors()
    .requireLambdaAuth(SessionContextSchema)
    .done(async function (event): Promise<APIGatewayProxyStructuredResultV2> {
            const authContext = event.requestContext.authorizer.lambda
            return {
                statusCode: 200,
                body: JSON.stringify({
                    access_token: authContext.access_token,
                    id_token: authContext.id_token,
                    id_token_json: authContext.id_token_json,
                    access_token_json: authContext.access_token_json,
                    expires_at: authContext.access_token_expires_at
                })
            }
        }
    )