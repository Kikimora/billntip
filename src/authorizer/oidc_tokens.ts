import * as util from "util";
import {AxiosResponse} from "axios";

import http from "../http";
import {AuthModuleContext} from "./ctx";
import {CognitoJwtVerifier} from "aws-jwt-verify";
import _ from "lodash";
import {DescribeUserPoolClientCommand} from "@aws-sdk/client-cognito-identity-provider";
import {describeUserPoolClient} from "../cognito";

/**
 * Open ID Connect (OIDC) tokens.
 */
export interface OidcTokens {
    readonly refreshToken: string | undefined;
    readonly idToken: string;
    readonly accessToken: string;
    readonly expiresAt: number;
    readonly expiresAtSec: number;
    /**
     * Return parsed id token, available after a call to {@link verifyIdToken}
     */
    readonly idTokenPayload: Object | null;
    /**
     * Return parsed access token, available after a call to {@link verifyAccessToken}
     */
    readonly accessTokenPayload: Object | null;

    /**
     * Verify id token using keys from OIDC provider key store.
     */
    verifyIdToken(): Promise<any>;

    /**
     * Verify access token using keys from OIDC provider key store.
     */
    verifyAccessToken(): Promise<any>;
}

export type OidcTokensModule = {
    authorizationCode: (code: string, callbackUrl: string) => Promise<OidcTokens | null>,
    refresh: (refreshToken: string) => Promise<OidcTokens | null>
}

export default function (ctx: AuthModuleContext): OidcTokensModule {

    // Verifier that expects valid access tokens:
    const accessVerifier = CognitoJwtVerifier.create({
        userPoolId: ctx.userPoolId,
        tokenUse: "access",
        clientId: ctx.clientId,
    });
    const idVerifier = CognitoJwtVerifier.create({
        userPoolId: ctx.userPoolId,
        tokenUse: "id",
        clientId: ctx.clientId,
    });

    const secret = _.memoize(async function () : Promise<string> {
        const {ClientSecret: clientSecret} = await describeUserPoolClient(ctx.userPoolId, ctx.clientId)
        if (clientSecret === undefined) {
            throw new Error('Cannot read Cognito user pool client secret, either public client or Lambda function permission issue.')
        }
        return clientSecret
    })

    class OidcTokensImpl implements OidcTokens {
        private _idTokenPayload: Object | null = null
        private _accessTokenPayload: Object | null = null;

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

        async verifyIdToken() {
            return this._idTokenPayload = await idVerifier.verify(this.idToken)
        }

        get idTokenPayload() {
            return this._idTokenPayload
        }

        async verifyAccessToken() {
            return this._accessTokenPayload = await accessVerifier.verify(this.idToken)
        }

        get accessTokenPayload() {
            return this._accessTokenPayload
        }

        public static async refresh(refreshToken: string): Promise<OidcTokens | null> {
            const params = {
                'grant_type': 'refresh_token',
                'client_id': ctx.clientId,
                'client_secret': await secret(),
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