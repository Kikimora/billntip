import {
    AuthModuleEnv,
    AuthModuleVariables,
    Env,
    initModuleVariables
} from "./ctx";
import OidcTokens, {idTokenVerifier, accessTokenVerifier} from "./oidc_tokens"
import SessionCookie from "./cookie"
import SessionData from "./session"

export interface TokenEndpointResponse {
    access_token: string
    id_token: string
    refresh_token: string
    expires_in: number
}

/**
 * Authentication module provides primitives to build cookie based authentication solution.
 */
export type AuthModule = {
    readonly SessionCookie: typeof SessionCookie,
    readonly SessionData: typeof SessionData,
    readonly OidcTokens: typeof OidcTokens,
    readonly env: AuthModuleEnv,
    readonly vars: AuthModuleVariables,
}

export {idTokenVerifier, accessTokenVerifier}

export async function startAuthOperation(): Promise<AuthModule> {
    const vars = await initModuleVariables()
    return {
        SessionCookie, OidcTokens, SessionData,
        vars,
        env: Env,
    }
}
