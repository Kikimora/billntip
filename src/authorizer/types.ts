import {Static, Type as T} from "@sinclair/typebox";
import {CognitoIdTokenPayload} from "aws-jwt-verify/jwt-model";

export const ProfileSchema = T.Object({
    "at_hash": T.Optional(T.String()),
    "aud": T.String(),
    "auth_time": T.Number(),
    "cognito:groups": T.Optional(T.Array(T.String())),
    "cognito:username": T.String(),
    "email": T.String(),
    "email_verified": T.Boolean(),
    "event_id": T.Optional(T.String()),
    "exp": T.Number(),
    "iat": T.Number(),
    "iss": T.String(),
    "jti": T.String(),
    "origin_jti": T.Optional(T.String()),
    "sub": T.String(),
    "token_use": T.Literal("id")
})
export type Profile = Static<typeof ProfileSchema>
export const SessionContextSchema = T.Object({
    /**
     * Session identifier.
     */
    id: T.String(),
    /**
     * Session update timestamp.
     */
    updated_at: T.Number(),
    /**
     * Access Token from OIDC provider initiated the session.
     */
    access_token: T.String(),
    /**
     * Parsed Access token.
     */
    access_token_json: T.Record(T.String(), T.Any()),
    /**
     * ID Token from OIDC provider initiated the session.
     */
    id_token: T.String(),
    /**
     * Parsed ID Token
     */
    id_token_json: ProfileSchema,
    /**
     * Access token expiration time as **seconds** since the [epoch]{@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date#the_epoch_timestamps_and_invalid_date}.
     * Calculated at tokens arrival as "{@link now} + {@link OidcTokens.expiresIn}".
     */
    access_token_expires_at: T.Number(),
    /**
     * Session cookie expiration time as **seconds** since the [epoch]{@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date#the_epoch_timestamps_and_invalid_date}.
     */
    session_expires_at: T.Number()
})

export type SessionContext = Static<typeof SessionContextSchema>

export interface OperationContext {
    readonly requestId: string
    /**
     * Operation start time in **seconds**.
     */
    readonly now: number
    readonly authorizerCacheTtl: number
    readonly refreshTokenTtl: number
    readonly accessTokenTtl: number
    readonly clientSecret: string
    readonly tokenEndpoint: string
    readonly postAuthRedirectUrl: string
    readonly clientId: string
    readonly cookieName: string
    readonly sameSite: "none" | "strict" | "lax",
    /**
     * Cookie time to live in **seconds**. Default is 3 days. Cannot be more than the {@link refreshTokenTtl}.
     */
    readonly sessionInactivityTimeout: number
}

export interface TokenVerifier<T> {
    verify(token: string): Promise<T>;
}