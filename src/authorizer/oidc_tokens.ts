import {AxiosResponse} from "axios";

import http from "../http";
import {Env, useVariables} from "./ctx";
import {CognitoJwtVerifier} from "aws-jwt-verify";
import {CognitoAccessTokenPayload, CognitoIdTokenPayload} from "aws-jwt-verify/jwt-model";
import {errorContext, withErrorContext} from "@app/diagnostics";

export const accessTokenVerifier = CognitoJwtVerifier.create({
    userPoolId: Env.userPoolId,
    tokenUse: "access",
    clientId: Env.clientId,
})

export const idTokenVerifier = CognitoJwtVerifier.create({
    userPoolId: Env.userPoolId,
    tokenUse: "id",
    clientId: Env.clientId,
})

/**
 * Open ID Connect (OIDC) tokens.
 */
export default class OidcTokens {
    private _idTokenPayload: CognitoIdTokenPayload | null = null
    private _accessTokenPayload: CognitoAccessTokenPayload | null = null;

    /**
     * @param refreshToken opaque blob to be used with OIDC token endpoint to refresh access and id tokens.
     * @param idToken contains user related information such as groups, roles, email, phone, etc.
     * @param accessToken contains permission related information such as access scopes.
     * @param expiresIn access token expiration period in seconds.
     */
    private constructor(readonly refreshToken: string | undefined,
                        readonly idToken: string,
                        readonly accessToken: string,
                        readonly expiresIn: number) {
    }

    /**
     * Verify id token using keys from OIDC provider key store.
     */
    async verifyIdToken() {
        try {
            return this._idTokenPayload = await idTokenVerifier.verify(this.idToken)
        } catch (e) {
            errorContext(e, "verifyIdToken", {idToken: this.idToken})
            throw e
        }
    }

    /**
     * Return parsed id token, available after a call to {@link verifyIdToken}
     */
    get idTokenPayload() {
        return this._idTokenPayload
    }

    /**
     * Verify access token using keys from OIDC provider key store.
     */
    async verifyAccessToken() {
        try {
            return this._accessTokenPayload = await accessTokenVerifier.verify(this.accessToken)
        } catch (e) {
            errorContext(e, "verifyAccessToken", {accessToken: this.accessToken})
            throw e
        }
    }

    /**
     * Return parsed access token, available after a call to {@link verifyAccessToken}
     */
    get accessTokenPayload() {
        return this._accessTokenPayload
    }

    public static async refresh(refreshToken: string): Promise<OidcTokens | null> {
        const {clientSecret} = useVariables()
        const params = {
            'grant_type': 'refresh_token',
            'client_id': Env.clientId,
            'client_secret': clientSecret,
            'refresh_token': refreshToken
        }
        const config = {
            headers: {'Content-Type': 'application/x-www-form-urlencoded'}
        };
        const response = await http.post(Env.tokenEndpoint, params, config)
        switch (response.status) {
            case 200:
                // TODO should I verify returned tokens given that they come from a trusted location?
                return OidcTokens.fromOidcResponse(response, false);
            case 400:
                return null
            default:
                const e = new Error('OIDC server failed with unexpected error')
                const {client_secret, refresh_token, ...request} = params
                const {data, headers, status} = response
                errorContext(e, "refresh", {
                    response: {data, headers, status},
                    request
                })
                throw e
        }
    }

    /**
     * Request tokens using authorization code grant
     */
    public static async authorisationCode(code: string, callbackUrl: string): Promise<OidcTokens | null> {
        const {clientSecret} = useVariables()
        const params = {
            'grant_type': 'authorization_code',
            'client_id': Env.clientId,
            'client_secret': clientSecret,
            'redirect_uri': callbackUrl,
            'code': code,
        }

        const config = {
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        };

        const response = await http.post(Env.tokenEndpoint, params, config)
        switch (response.status) {
            case 200:
                return OidcTokens.fromOidcResponse(response, true)
            case 400:
                return null;
            default:
                const error = Error('OIDC server failed with unexpected error')
                const {client_secret, code, ...request} = params
                const {data, headers, status} = response
                throw withErrorContext(error, "authorisationCode", {
                    response: {data, headers, status},
                    request
                })
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
        return new OidcTokens(refreshToken, idToken, accessToken, expiresIn)
    }
}
