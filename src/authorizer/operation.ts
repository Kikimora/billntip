import _ from "lodash";
import {userPoolClientDetails} from "../cognito";
import {toSeconds} from "@app/util";
import {Static, TObject, Type} from "@sinclair/typebox";
import {registerDefaultFormats, bootstrap} from "@app/lambda";
import {OperationContext, SessionContextSchema} from "./types";
import {SessionRepo} from "./session";
import {OIDCTokensRepo} from "./oidc_tokens";
import {SessionCookieRepo} from "./cookie";
import {CognitoJwtVerifier} from "aws-jwt-verify";
import {TypeCompiler} from "@sinclair/typebox/compiler";

registerDefaultFormats()

export type {SessionRepo, SessionData} from "./session";
export type {OIDCTokensRepo, OidcTokens} from "./oidc_tokens";
export type {SessionCookieRepo, SessionCookie} from "./cookie";
export {SessionContext, SessionContextSchema} from "./types";

export const SessionContextCheck = TypeCompiler.Compile(SessionContextSchema)

export const AuthOptionsSchema = {
    dynamodb: Type.Object({
        sessions: Type.String(),
        locks: Type.String(),
    }),
    oidc: Type.Object({
        userPoolId: Type.String(),
        issuer: Type.String(),
        tokenEndpoint: Type.String(),
    }),
    api: Type.Object({
        clientId: Type.String(),
        cookieName: Type.String(),
        sessionInactivityTimeout: Type.Number({default: 3 * 24 * 3600}),
        /**
         * Session cookie SameSite: strict, none or Lax
         */
        sameSite: Type.Union([Type.Literal("none"), Type.Literal("strict"), Type.Literal("lax")]),
        postAuthRedirectUrl: Type.String({format: "uri"}),
        /**
         * Authorizer cache TTL in seconds
         */
        authorizerCacheTtl: Type.Number({minimum: 10}),
    }),
} as const;
const config = bootstrap()
    .parameters(AuthOptionsSchema)
    .buildConfig()

export type AuthOptions = Static<TObject<typeof AuthOptionsSchema>>

async function buildAuthModule({dynamodb, oidc, api}: AuthOptions, requestId?: string) {
    const {userPoolId, tokenEndpoint} = oidc
    const {clientId, sessionInactivityTimeout, cookieName, sameSite, postAuthRedirectUrl, authorizerCacheTtl} = api
    const userPoolClient = await userPoolClientDetails(userPoolId, clientId)
    const units = userPoolClient.TokenValidityUnits ?? _.throw("User pool must have tokens validity setting.")
    const accessTokenTtl = userPoolClient.AccessTokenValidity ?? _.throw("User pool must have access token validity setting.");
    const accessTokenUnits = units.AccessToken ?? _.throw("User pool must have access token validity setting.")
    const refreshTokenTtl = userPoolClient.RefreshTokenValidity ?? _.throw("User pool must have refresh token validity setting.");
    const refreshTokenUnits = units.RefreshToken ?? _.throw("User pool must have refresh token validity setting.")
    const clientSecret = userPoolClient.ClientSecret ?? _.throw("User pool must have a client secret configured.")

    const ctx: OperationContext = {
        now: Math.floor((performance.now() + performance.timeOrigin) / 1000),
        requestId: requestId ?? "",
        refreshTokenTtl: toSeconds(refreshTokenTtl, refreshTokenUnits),
        authorizerCacheTtl,
        accessTokenTtl: toSeconds(accessTokenTtl, accessTokenUnits),
        clientId,
        clientSecret,
        tokenEndpoint,
        postAuthRedirectUrl,
        cookieName,
        sameSite,
        sessionInactivityTimeout
    }

    const cookies = new SessionCookieRepo(ctx)
    const sessions = new SessionRepo({
        ctx,
        locksTable: dynamodb.locks,
        sessionTable: dynamodb.sessions,
        cookies
    })
    const tokens = new OIDCTokensRepo({
        accessTokenVerifier: CognitoJwtVerifier.create({
            userPoolId: userPoolId,
            tokenUse: "access",
            clientId: clientId,
        }),
        idTokenVerifier: CognitoJwtVerifier.create({
            userPoolId: userPoolId,
            tokenUse: "id",
            clientId: clientId,
        }),
        ctx
    })

    return {sessions, tokens, cookies, ctx}
}

/**
 * Start authentication operation
 * @param requestId - request id
 * @param options - auth module options, default - load options from the parameter store
 * @returns authentication module
 */
export default async function (requestId?: string, options?: AuthOptions) {
    if (options !== undefined) return buildAuthModule(options, requestId)
    return await config.parameters.then(x => buildAuthModule(x, requestId))
}
