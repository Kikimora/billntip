import {AuthModuleContextSchema, AuthModuleOptions} from "./ctx";
import OidcTokensModule from "./oidc_tokens"
import SessionCookieModule from "./cookie"
import SessionModule from "./session"

export interface TokenEndpointResponse {
    access_token: string
    id_token: string
    refresh_token: string
    expires_in: number
}

export default authorizationModule;

/**
 * Authentication module provides primitives to build cookie based authentication solution.
 */
export function authorizationModule(options: AuthModuleOptions) {
    const ctx = AuthModuleContextSchema.parse({
        now: Math.floor(Date.now() / 1000),
        region: process.env.AWS_REGION,
        ...options,
    })


    const sessionCookieModule = SessionCookieModule(ctx);
    const sessionModule = SessionModule(sessionCookieModule.create, ctx);
    const oidcTokensModule = OidcTokensModule(ctx);

    return {
        /**
         * Wrapper around session cookie
         */
        SessionCookie: {
            ...sessionCookieModule
        },
        /**
         * Provides methods to load and create {@link SessionData}.
         */
        SessionData: {
            ...sessionModule
        },
        /**
         * OIDC tokens endpoint client.
         */
        OidcTokens: {
            ...oidcTokensModule
        },
        ctx
    }
}

