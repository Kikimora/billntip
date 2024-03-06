# Users management, authentication and authorization

## Key Design Decisions

1. Use OpenID protocol to authenticate users
2. Use AWS Cognito to store and manage user information
3. Store session identifier in a cookie
4. Use API Gateway Lambda authorizer to cache session and keep it up to date 

## About OIDC

OIDC protocol is simple on a surface (with many tricky details):

1. `domain.com` user opens login page on `oidc.domain.com`
2. User login, `oidc.domain.com` redirects user to predefined URL such as `domain.com/oidc/callback?code=....`
3. `domain.com` calls `oidc.domain.com/oauth/token?code=...` to get id, access and refresh tokens.

Here is a [good article](https://medium.com/klaxit-techblog/openid-connect-for-mobile-apps-fcce3ec3472) with visuals
explaining the above flow. There are few other flows defined in OAuth/OIDC spec most considered legacy now. Specifically
the implicit flow had been popular some time ago but today considered not safe. Recommendation is to use authorization
code flow with:

1. `client_secret` known only to the backend to force communication thru the backend.
2. `state` parameter acting as nonce to protect from replay attacks
3. PKCE verifier to protect the code from hijacking

Access token contains scopes that defines what resources and on what servers are available. Id token contains
information about a user such as id, email, groups, roles, etc. A server application supposed to authorize a request
based on these two data sources. For example: access token scope 'order' grants access to orders management while id
token role 'admin' allows all actions on all orders. At the same time if id token role is user then orders services
allows only limited operations with orders of this user. At a minimum OIDC access token grants access to OIDC resources
such as profile,self-service password change and likewise.

Application periodically refresh access and id tokens using refresh token. It is at the time of the refresh application
learn about important changes in user's status such as role changes or user deactivation. Because of this access tokens
are usually short-lived with lifespan ranging from minutes to a few hours.

OIDC can also be used as a federation protocol, hiding multiple identity providers (e.g. Google, Facebook, Apple) from a
client application. Imagine that on step 2 above user is redirected to `google.com`, login and redirected back
to `oidc.domain.com` with Google tokens. `oidc.domain.com` then generates its own tokens and returns them to app on
step&nbsp;3. Note how `domain.com` have no idea if password, Google or other identity provider was used. It only
deals with tokens from `oidc.domain.com`. Conversely, if `domain.com` wants to interact with Google API it will have to
authenticate with Google again. This time user gives consent to let `domain.com` access data on `google.com` whereas
before they give access to `oidc.domain.com`.

## Using Tokens to Manage HTTP sessions

OIDC flow ends with access, id and refresh tokens. Nothing is said in the OIDC standard about how to use these tokens to
create and maintain an HTTP session. The good way to do it:

1. Use secure, http only and strict cookies to store and pass session identifier in both browser and mobile apps.
2. Use short identifier instead of access or id token to represent session id. This is optional and reasonable if access
   token issued by OIDC provider is a large JWT token. E.g. cognito's access token can be over 1.5Kb.
3. Transparently refresh session by issuing a new cookie.

This method is good because it works for both mobile and browser and transparently refresh auth tokens. There is a
notable alternative, which is prone to issues with privacy aware browsers but still widely used:

1. Store access token in a secure, http only and strict cookie.
2. Build a mechanism to detect cookie expiration (because app cannot read cookie, so expiration has to be saved
   somewhere)
3. Use [silent authentication](https://auth0.com/docs/authenticate/login/configure-silent-authentication) - redirect to
   a third party auth app to refresh sessions. This redirect can happen in a hidden iframe.

Then there is another bad alternative:

1. Use access token to represent a session, send it in Authorization header.
2. Store refresh token in a local storage and use it to refresh access token as needed.

A better variation of above is to store refresh token in the local storage and
use [refresh token rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation). Still a lot of
manual work on the app side to maintain the session.

## Authentication flow

Assume application runs on `domain.com`

1. Typically, auth flow starts when app calls an API such as `api.domain.com/profile` and get 401 error
2. App saves original page URL to local storage and redirects to login page on `oidc.domain.com`
3. After successful authentication login page redirects to `domain.com/oidc/callback` with one time authorization code
4. App calls `api.domain.com/oidc/callback` with code, API responds with a session cookie.
5. The cookie is used to authenticate subsequent requests to api.domain.com

This flow can be adapted to mobile applications with small changes. Instead of redirecting to
`domain.com/oidc/callback` redirect happens to `myapp:/oidc/callback`

To generate session cookie on step 4 backend performs following sub-steps

1. Get id, access and refresh tokens from `oidc.domain.com/oauth/token` endpoint using authorization code grant.
2. Use refresh token to generate session identifier with pbkdf2 algorithm
3. Save session (access, id and refresh tokens) into the session store
4. Reply with secure http only session cookie containing session id

The very next request to `api.domain.com` after login would trigger Lambda Authorizer (step 5 of the interaction
above). The authorizer then performs following steps:

1. Load tokens from the store using value from the session cookie
2. Check if `now + authorizer cache ttl >= oidc access token validity - 2 min`, this condition makes sure that next
   authorizer invocation happens before oidc access token expires.
3. If condition is not met then authorizer refresh access token using refresh token and saves new tokens into the store.
4. Authorizer populates authorizer context with access and id tokens.
5. API GW caches authorizer context and makes it available to the Lambda function handling API request or downstream
   HTTP endpoint.

Note how this algorithm maintains valid and up-to-date access and id token. This may come in handy in combination with
OAuth resource servers.

## Authorizing requests in a downstream service

API GW Authorizer function in fact does authentication by verifying correct tokens present in the session store. It then
makes tokens available to downstream services. Lambda function receive tokens
in `event.requestContext.authorizerContext`. HTTP integration receive tokens in HTTP headers as configured by context
parameter mapping.

As briefly mentioned in [About OIDC](#about-oidc) section downstream service combine data from access and id token to
authorize action. While reading token data services can skip token validation if they can be called only by the API GW.
What goes into id token can be configured in Cognito, usually it is user groups, roles and other user attributes.
Recommended use of this information is follows:

1. Check access token scopes to validate token is suited for the service and target resource. E.g. require orders:view
   to view orders and orders:manage to manage them.
2. Use id token data to determine if a particular resource can be viewed/modified by the caller. E.g. require role:admin
   to manage any order, otherwise limit access to user owned orders.
3. Consider scenarios without id token. This happens in server to server communication when tokens obtained
   using `client_credentials` flow using `client_id` and `client_secret`. In these scenarios caller in the service
   itself.

## Implementation Details

Session cookie must be `Secure` and `HttpOnly`, preferably `SameSite=Strict`. There is a problem with the last one.
Authorization code flow OIDC calls return URL with the code, URL changes code for tokens and responds
with `302 Redirect` response sending user back to the application together with `Set-Cookie` header. This flow does not
work well with SameSite=Strict cookies. Because cookie is set in a redirect browsers ignore `SameSite=Strict` cookies,
meaning that responding with `302 Redirect` while also setting SameSite=Strict cookie is not possible. The workaround is
to respond `200 OK` with `Set-Cookie` header in combination with HTML redirect
using `<meta http-equiv="refresh" content="0;URL=...>` tag.

Authorizer cannot issue cookies by itself, it has to rely on proper API GW configuration. Authorizer function sets
context parameter `new_cookie` when it wants to issue a new cookie. API GW Integration maps `new_cookie` to `Set-Cookie`
header in order for this to work. Similarly, authorizer expose tokens as `access_token` and `id_token` context values.
If HTTP backend is used then integration has to convert those into HTTP headers to make values available to the backend.

Because authorizer function reads `Cookie` header API GW Authorizer must have this header as the identity source. If app
changes cookie header often it can negatively impact cache performance.

API GW cache has an interesting interplay with `new_cookie` context value. Authorizer sets `new_cookie` context variable
when token refresh results in a new refresh token. This usually means that old refresh token cannot be used anymore, any
use of it would invalidate all user tokens and force login. This is called refresh token rotation and implemented in a
few OIDC providers but not in Cognito. New refresh token has extended expiration meaning we want to also extend the
session cookie expiration. Because primary purpose of refresh token rotation is to fight credentials theft we want to
shut down old cookie asap. To achieve this authorizer function sets `new_cookie` with new unique session id and extended
expiration and removes old session from the storage. `new_cookie` value then cached by API GW authorizer cache, note
that in this case the cache key is old cookie. Afterward API GW reuse cached value for all requests with old cookie
resulting in `Set-Cookie` header in the response (because of how integration setup, see above). After cache entry
expires response changed to `401 Unauthorized` error because authorizer function cannot find corresponding session in
the store.

Another tricky issue is concurrent token refreshes that happen when user makes two or more requests that hit empty API
GW authorizer cache. When this happens API GW calls authorizer function concurrently, one time for each concurrent
request. Authorizer function reads tokens (1), refreshes (2) them and then writes (3) back to store. This can result in
a mess if not properly coordinated. We solve this by placing a lock inside session record. Concurrent requests would
poll on a session until lock released or polling timeout.

## Cognito User Pools and their clients

Cognito is built around two core entities - User Pool and User Pool Client

* User Pool is a users database with OIDC, and its own API on top.
* User Pool Client represents credentials to access User Pool API and associated configuration

As such User Pool defines everything about your users and how they login and signup. Things like domain, identity
providers, user attributes schema, password policy, **hooks** and messaging configuration (including message templates)
all fall down below user pool configuration. User Pool Client is nothing more than credential to access a user pool. It
can be anonymous (aka public) in which case it is identified by a client id, anyone in the internet can use this id to
signup or sign-in into a user pool. User Pool Client can have associated secret, in which case it is classified as
private and every User Pool API call has to have a client secret together with client id. Choosing between one or
multiple user pool clients is similar in nature to the question of using one or more API keys to work with an API.

### User Pool APIs

User Pool has 4 different types of API endpoints

* Hosted UI which is not really an API but a collection
  of [pre-built pages](https://docs.aws.amazon.com/cognito/latest/developerguide/hosted-UI-endpoints.html) to perform
  common tasks such as login, signup and self-service operations such as forgot password, configure MFA, verify email or
  phone number.
* [OIDC endpoints and pre-built callback URLs](https://docs.aws.amazon.com/cognito/latest/developerguide/federation-endpoints.html)
  collectively user pool called federation endpoints. This is standard OIDC endpoints such as `authorize` (aka redirect
  me to a login page), `token` (aka give me tokens), `revoke` (aka logout) and `userInfo` (aka give me my user details)
  plus two callbacks `oauth2/idpresponse` and `saml2/idpresponse`. You supposed to configure identity providers (e.g.
  Google, Facebook, etc) to redirect your users to these callbacks once login process finishes.
* User Pool Client API. This is AWS style API which you can use to build you own version of Hosted UI. These are APIs
  like [`InitiateAuth`](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_InitiateAuth.html)
  or [`UpdateUserAttributes`](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_UpdateUserAttributes.html).
  They need either client_id or access token for authorization and do not require any backend on your end. Because this
  APIs designed to be called by a user they often does not simply complete a task but initiate a flow. For
  example `InitiateAuth` given login and password does not always generate tokens right away. Instead, it may return
  with a request to provide a 2FA code (this is called a challenge). In the same way `UpdateUserAttributes` may send
  email or SMS messages with configuration code instead of updating attributes right away. Then it is your
  responsibility to call `VerifyUserAttribute` with the right code. In practice, I've never seen anyone use these APIs
  which is a big mistake. Instead, people use IAM protected APIs (described below) behind their custom backend,
  effectively building poorly working version of already available User Pool Client API.
* User Pool IAM authenticated APIs. These fall into two categories
    * User Pool Management APIs such
      as [`CreateGroup`](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateGroup.html)
    * User management APIs such
      as [`AdminUpdateUserAttributes`](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminUpdateUserAttributes.html).
      Please note the difference with `UpdateUserAttributes`. The latter needs access token, while the former needs IAM
      credentials. You use user management APIs from inside your backend in contrast with the User Pool Client API which
      is to be used from a browser or a mobile app.

### Identity Providers (IdPs), Identity Federation and SSO

* Identity Provider (IdP) is a user database managed by a third-party application which we can use to authenticate users
  and get some information about them.
* Identity federation is how we authenticate our app to an identity provider and how we map user attributes from the
  identity provider to our user attributes schema.
* SSO (single sign-on) is when users can use same login/password (more generally one set of credentials) to login into
  multiple applications. 99% of the time this happens because users login into one app, which returns tokens
  understandable by other apps thanks to identity federation. The original app acts as an identity provider in this
  case.

In Cognito new users may signup with email and/or phone number and that would create a native Cognito user. They can
use an identity provider such as Google to signup that would create a federated user. Both are Cognito users but treated
slightly differently because of the federation. Every time user login using Google (or other IdP) Cognito updates user
attributes from information provided by Google. Because of this your app may treat such users differently. For example
it does not make sense to update attributes coming from an IdP because they would be overwritten after the next login.
This is a rough sketch of how this happens

1. User navigates to a login page.
2. User clicks on 'Login With Google' and goes to Google.
3. Once done Google redirect user to `oauth2/idpresponse?code=GOOGLE_CODE` (assume we do authorization code flow here).
4. Cognito uses the code to get Google access and id token.
5. Cognito updates user information using these tokens and throws them away.
6. Cognito redirect user to a `my/callback?code=COGNITO_CODE`
7. Your app exchange code for cognito access and id tokens. Id token contains recent information from Google. 
