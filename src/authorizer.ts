import {
    APIGatewayAuthorizerEvent,
    APIGatewayProxyEventV2,
    APIGatewaySimpleAuthorizerWithContextResult,
    APIGatewayProxyStructuredResultV2
} from "aws-lambda";
import {authorizationModule} from "./authorizer/module";

const Unauthorized = {isAuthorized: false, context: {}}
const BadRequest = {statusCode: 400, body: JSON.stringify({'error': 'Invalid request parameters.'})}
type AuthResult = APIGatewaySimpleAuthorizerWithContextResult<any>

const authOptions = {
    cookieName: process.env.COOKIE_NAME ?? 'JSESSIONID',
    sessionTable: process.env.SESSION_TABLE ?? 'sessions',
    refreshTokenTtlSec: Number(process.env.REFRESH_TOKEN_TTL),
    cacheTtlSec: Number(process.env.CACHE_TTL),
    userPoolId: process.env.USER_POOL_ID,
    clientId: process.env.OAUTH_CLIENT_ID, //user pool client id
    issuer: process.env.OAUTH_ISSUER,
    tokenEndpoint: process.env.OAUTH_TOKEN_ENDPOINT,
    postAuthRedirectUrl: process.env.POST_AUTH_REDIRECT_URL,
    region: process.env.AWS_REGION,
}
const {SessionData, SessionCookie, OidcTokens, ctx} = authorizationModule(authOptions)

type AuthorizerHooks = {
    cookieAuthorizerStart?: () => Promise<void>,
    cookieAuthorizerRefresh?: () => Promise<void>;
    cookieAuthorizerNewSession?: () => Promise<void>;
    cookieAuthorizerFinish?: () => Promise<void>,
}
export const hooks: AuthorizerHooks = {}

// noinspection JSUnusedGlobalSymbols
/**
 * Authorize request based on a cookie value. The authorizer performs following steps:
 * 1. Check cookies for a valid session identifier.
 * 2. Find corresponding session data with OIDC refresh and access tokens.
 * 3. If access token is about to expire or expired then refresh the session using OpenId token endpoint.
 * 4. If refresh token changed then request API GW integration to issue a new cookie by setting `context.new_cookie` value.
 * 5. Populate `context.access_token` and `context.id_token` values. These variables can be accessed by the endpoint handler.
 *
 * Cookie format is <session_id>.<salt>. Session id is stable, salt refreshes every time refresh token changes.
 * Old cookie (with an old salt) is still valid for some time but requests made with it would return Set-Cookie header
 * with the new cookie.
 *
 * **Important!** Authorizer requires proper API GW configuration:
 * 1. API GW Integration on a route protected with authorizer MUST map `header.Set-Cookie` to `$context.authorizer.new_cookie`
 * 2. Authorizer identity source MUST be `$request.header.Cookie`.
 *
 * Session data contains access token issued by the OIDC server. This token controls access to the OIDC server API for
 * things like profile access, password change, etc. Access token refresh happens if
 * `now + authorizer cache ttl >= access token expiration - 2 min`. In other words if we expect next authorizer call to
 * happen after access token expires. Note how this condition guarantees that `context.access_token` contains valid
 * access token at all times. This is because authorizer cache always expires before the token and authorizer called
 * before request handler (giving it a chance to populate `context.access_token` with a fresh value). If `cache ttl` is 0
 * meaning there is no cache and authorizer called on every request then access token refresh happens when token is about to expire.
 *
 * If refresh token changes then authorizer issues a new cookie and immediately deletes previous cookie from the session store.
 * Next request with a new cookie which triggers authorizer call again (because of how identity source configured).
 * These two requests leave two entries in the authorizer cache:
 * 1. Old Cookie -> { new_cookie:"...", access_token:"new token", id_token:"new token", refresh_token:"new token" }
 * 2. New Cookie -> { access_token:"new token", id_token:"new token", refresh_token:"new token" }
 * If client keeps using old cookie then every response will have Set-Cookie header until authorizer cache entry is not
 * expired. After if expires client with old cookie would get 410 Unauthorized.
 *
 */
export async function cookie(event: APIGatewayAuthorizerEvent): Promise<AuthResult> {
    ctx.now = Math.floor(Date.now() / 1000)

    switch (event.type) {
        case "REQUEST": {
            const cookieHeader = event.headers?.cookie
            if (cookieHeader == null) return Unauthorized
            const sessionCookie = SessionCookie.load(cookieHeader)
            if (sessionCookie == null) return Unauthorized
            const session = await SessionData.loadAndLock(sessionCookie.id)
            if (session == null) return Unauthorized

            try {
                let response: AuthResult = {isAuthorized: false, context: {}}
                if (hooks.cookieAuthorizerStart) {
                    await hooks.cookieAuthorizerStart()
                }
                if (session.isTimeToRefresh) {
                    if (hooks.cookieAuthorizerRefresh) {
                        await hooks.cookieAuthorizerRefresh()
                    }
                    const tokens = await OidcTokens.refresh(session.refreshToken)
                    if (tokens == null) {
                        await session.remove();
                        return Unauthorized
                    }

                    const updatedSession = session.withTokens(tokens)
                    if (updatedSession.isRefreshTokenRotated) {
                        if (hooks.cookieAuthorizerNewSession) {
                            await hooks.cookieAuthorizerNewSession()
                        }
                        const newCookie = updatedSession.makeCookie()
                        await updatedSession.save()
                        await session.remove()

                        response = {
                            isAuthorized: true,
                            context: {
                                'new_cookie': newCookie.makeHeaderValue(),
                                ...updatedSession.context()
                            }
                        }
                    } else {
                        await updatedSession.save()
                        response = {
                            isAuthorized: true,
                            context: {
                                ...updatedSession.context()
                            }
                        }
                    }
                } else {
                    response = {
                        isAuthorized: true,
                        context: {
                            ...session.context()
                        }
                    }
                }
                return response
            } finally {
                await session.release()
                if (hooks.cookieAuthorizerFinish) {
                    await hooks.cookieAuthorizerFinish()
                }
            }
        }
        default:
            return Unauthorized
    }
}

// noinspection JSUnusedGlobalSymbols
/**
 * Handle authorization code grant callback. The callback is called by OIDC server after it verified user credentials.
 * The 'code' parameter contains one time code to get id, access and refresh tokens.
 */
export async function code(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
    ctx.now = Math.floor(Date.now() / 1000)
    //TODO support OAuth PKCE for better security
    const code = event.queryStringParameters?.['code'] ?? ""
    const callbackUrl = `https://${event.requestContext.domainName}${event.rawPath}`
    const tokens = await OidcTokens.authorizationCode(code, callbackUrl)
    if (tokens == null) return BadRequest

    const idTokenPayload = await tokens.verifyIdToken()
    if (idTokenPayload != null) {
    }

    const session = SessionData.fromTokens(tokens)
    const cookie = session.makeCookie()
    await session.save()

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
<meta http-equiv="refresh" content="0;URL='${ctx.postAuthRedirectUrl}'"/>
<title>Bill & Tip</title>
</head>
<body><p>Moved to <a href="${ctx.postAuthRedirectUrl}">${ctx.postAuthRedirectUrl}</a>.</p></body>
</html>
        `
    }
}

// Sample code to load SSM parameters, keep it here just in case I need it soon.
//
// import {GetParameterCommand, SSMClient} from '@aws-sdk/client-ssm'
// import {loadAsync} from "./util";
// const OPENID_PROVIDER_CONFIG = process.env.OPENID_PROVIDER_CONFIG
// const ssmClient = new SSMClient({region: process.env.AWS_REGION})
//
// const getOpenIdParameters = loadAsync(async function () {
//     const getCommand = new GetParameterCommand({
//         Name: OPENID_PROVIDER_CONFIG,
//         WithDecryption: true
//     });
//     const config = await ssmClient.send(getCommand)
//     const value = config?.Parameter?.Value
//     if (value == null) throw new Error("OpenID is not configured")
//     const params = JSON.parse(value) as { clientId: string, clientSecret: string }
//     if (params.clientId == null || params.clientSecret == null)
//         throw new Error("Incorrect OpenID configuration: clientId or clientSecret is missing.")
//     return params
// })

