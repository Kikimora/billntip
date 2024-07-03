import {AxiosResponse} from "axios";
import {CognitoAccessTokenPayload, CognitoIdTokenPayload} from "aws-jwt-verify/jwt-model";
import http from "../http";
import {errorContext, errorWithContext} from "@app/diagnostics";
import {OperationContext, TokenVerifier} from "./types";

export interface TokenEndpointResponse {
    access_token: string
    id_token: string
    refresh_token: string
    expires_in: number
}

interface OidcTokensOptions {
    idTokenVerifier: TokenVerifier<CognitoIdTokenPayload>
    accessTokenVerifier: TokenVerifier<CognitoAccessTokenPayload>
    ctx: OperationContext
}

export class OIDCTokensRepo {

    constructor(private readonly options: OidcTokensOptions) {
    }

    public createTokens(refreshToken: string | undefined,
                        idToken: string,
                        accessToken: string,
                        expiresIn: number) {
        return new OidcTokens(refreshToken, idToken, accessToken, expiresIn, this.options)
    }

    public async refresh(refreshToken: string): Promise<OidcTokens | null> {
        const {clientSecret, tokenEndpoint, clientId} = this.options.ctx
        const params = {
            'grant_type': 'refresh_token',
            'client_id': clientId,
            'client_secret': clientSecret,
            'refresh_token': refreshToken
        }
        const config = {
            headers: {'Content-Type': 'application/x-www-form-urlencoded'}
        };
        const response = await http.post(tokenEndpoint, params, config)
        switch (response.status) {
            case 200:
                // TODO should I verify returned tokens given that they come from a trusted location?
                return this.fromOidcResponse(response, false);
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
    public async authorisationCode(code: string, callbackUrl: string): Promise<OidcTokens | null> {
        const {clientSecret, tokenEndpoint, clientId} = this.options.ctx
        const params = {
            'grant_type': 'authorization_code',
            'client_id': clientId,
            'client_secret': clientSecret,
            'redirect_uri': callbackUrl,
            'code': code,
        }

        const config = {
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        };

        const response = await http.post(tokenEndpoint, params, config)
        switch (response.status) {
            case 200:
                return this.fromOidcResponse(response, true)
            case 400:
                return null;
            default:
                const error = Error('OIDC server failed with unexpected error')
                const {client_secret, code, ...request} = params
                const {data, headers, status} = response
                throw errorWithContext(error, "authorisationCode", {
                    response: {data, headers, status},
                    request
                })
        }
    }

    /**
     * Request tokens using refresh token grant
     */
    private fromOidcResponse(response: AxiosResponse, requireRefreshToken: boolean = false) {
        const data = response.data
        const accessToken = data['access_token'];
        const idToken = data['id_token'];
        const expiresIn = Number(data['expires_in']);
        if (accessToken == null || idToken == null || isNaN(expiresIn))
            return null
        const refreshToken = data['refresh_token'];
        if (requireRefreshToken && refreshToken == null)
            return null
        return new OidcTokens(refreshToken, idToken, accessToken, expiresIn, this.options)
    }
}

/**
 * Open ID Connect (OIDC) tokens.
 */
export class OidcTokens {
    private _idTokenPayload: CognitoIdTokenPayload | null = null
    private _accessTokenPayload: CognitoAccessTokenPayload | null = null;

    /**
     * @param refreshToken opaque blob to be used with OIDC token endpoint to refresh access and id tokens.
     * @param idToken contains user related information such as groups, roles, email, phone, etc.
     * @param accessToken contains permission related information such as access scopes.
     * @param expiresIn access token expiration timeout
     * @param options token options
     */
    constructor(readonly refreshToken: string | undefined,
                readonly idToken: string,
                readonly accessToken: string,
                readonly expiresIn: number,
                readonly options: OidcTokensOptions) {
    }

    get refreshTokenExpiresIn() {
        return this.options.ctx.refreshTokenTtl
    }

    /**
     * Verify id token using keys from OIDC provider key store. Prerequisite before calling {@link idTokenPayload}.
     */
    async verifyIdToken() {
        const {idTokenVerifier} = this.options
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
     * Verify access token using keys from OIDC provider key store. Prerequisite before calling {@link accessTokenPayload}.
     */
    async verifyAccessToken() {
        const {accessTokenVerifier} = this.options
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
}
