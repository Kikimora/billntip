import IdTokenVerifier from "idtoken-verifier";
import * as util from "util";
import {AxiosResponse} from "axios";

import http from "../http";
import {AuthModuleContext} from "./ctx";

/**
 * Open ID Connect (OIDC) tokens.
 */
export interface OidcTokens {
    readonly refreshToken: string | undefined;
    readonly idToken: string;
    readonly accessToken: string;
    readonly expiresAt: number;
    readonly expiresAtSec: number;
    readonly idTokenPayload: Object | null;

    /**
     * Verify id token using keys from OIDC provider key store.
     */
    verifyIdToken(): Promise<any>;
}

export type OidcTokensModule = {
    authorizationCode: (code: string, callbackUrl: string) => Promise<OidcTokens | null>,
    refresh: (refreshToken: string) => Promise<OidcTokens | null>
}

export default function (ctx: AuthModuleContext): OidcTokensModule {

    const verifier = new IdTokenVerifier({
        issuer: ctx.issuer,
        audience: ctx.clientId
    });
    const verify = util.promisify(verifier.verify.bind(verifier))

    class OidcTokensImpl implements OidcTokens {
        private _idTokenPayload: Object | null = null

        /**
         *
         * @param refreshToken opaque blob to be used with OIDC token endpoint to refresh access and id tokens.
         * @param idToken contains user related information such as groups, roles, email, phone, etc.
         * @param accessToken contains permission related information such as access scopes.
         * @param expiresAt access token expiration period in milliseconds.
         */
        constructor(readonly refreshToken: string | undefined,
                    readonly idToken: string,
                    readonly accessToken: string,
                    readonly expiresAt: number) {
        }

        /**
         * Access token expiration period in seconds (unix timestamp).
         */
        get expiresAtSec() {
            return Math.floor(this.expiresAt / 1000);
        }

        /**
         * Verify id token using keys from OIDC provider key store.
         */
        async verifyIdToken() {
            return this._idTokenPayload = await verify(this.idToken)
        }

        /**
         * Return parsed id token, available after a call to {@link verifyIdToken}
         */
        get idTokenPayload() {
            return this._idTokenPayload
        }

        public static async refresh(refreshToken: string): Promise<OidcTokens | null> {
            const params = {
                'grant_type': 'refresh_token',
                'client_id': ctx.clientId,
                'refresh_token': refreshToken
            }
            const config = {
                headers: {'Content-Type': 'application/x-www-form-urlencoded'}
            };
            const response = await http.post(ctx.tokenEndpoint, params, config)
            switch (response.status) {
                case 200:
                    // TODO should I verify returned tokens given that they come from a trusted location?
                    return OidcTokensImpl.fromOidcResponse(response, false);
                case 400:
                    return null
                default:
                    throw new Error('OIDC server failed with unexpected error')
            }
        }

        /**
         * Request tokens using authorization code grant
         */
        public static async authorisationCode(code: string, callbackUrl: string): Promise<OidcTokens | null> {

            const params = {
                'grant_type': 'authorization_code',
                'client_id': ctx.clientId,
                'redirect_uri': callbackUrl,
                'code': code,
            }

            const config = {
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            };
            const response = await http.post(ctx.tokenEndpoint, params, config)
            switch (response.status) {
                case 200:
                    return OidcTokensImpl.fromOidcResponse(response, true)
                case 400:
                    return null;
                default:
                    throw new Error('OIDC server failed with unexpected error')
            }
        }

        /**
         * Request tokens using refresh token grant
         */
        private static fromOidcResponse(response: AxiosResponse, requireRefreshToken: boolean = false) {
            const data = response.data
            const accessToken = data['access_token'];
            const idToken = data['id_token'];
            const expiresIn = Number(data['expires_in']);
            if (accessToken == null || idToken == null || isNaN(expiresIn))
                return null
            const refreshToken = data['refresh_token'];
            if (requireRefreshToken && refreshToken == null)
                return null
            return new OidcTokensImpl(refreshToken, idToken, accessToken, expiresIn)
        }
    }

    return {
        authorizationCode: OidcTokensImpl.authorisationCode,
        refresh: OidcTokensImpl.refresh
    }
}