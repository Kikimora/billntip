import * as pulumi from "@pulumi/pulumi";
import {pool, client, domain} from "../cognito"
import {tokenValidityInSeconds} from "../cognito/util";
import {sessionsTable, locksTable, dataTable} from "../dynamodb"
import {gateway} from "./gateway";

const config = new pulumi.Config("aws")
const region = config.get("region")
const issuer = pulumi.interpolate`https://cognito-idp.${region}.amazonaws.com/${pool.id}`

const accessTokenTtl = tokenValidityInSeconds("accessToken");
const idTokenTtl = tokenValidityInSeconds("idToken");
if (accessTokenTtl < 180 || idTokenTtl < 180) throw new Error("User Pool Client tokens should last longer than 3 minutes")
//Cache tokens for almost entire lifetime
const cognitoDomain = pulumi.interpolate`https://${domain}.auth.${region}.amazoncognito.com`

export const CacheTtl = accessTokenTtl - 10;
export const AuthEnv = {
    COOKIE_NAME: 'JSESSIONID',
    SESSION_TABLE: sessionsTable.name,
    LOCKS_TABLE: locksTable.name,
    USER_POOL_ID: pool.id,
    OAUTH_CLIENT_ID: client.id, //user pool client id
    OAUTH_ISSUER: issuer,
    OAUTH_TOKEN_ENDPOINT: pulumi.interpolate`${cognitoDomain}/oauth2/token`,
    POST_AUTH_REDIRECT_URL: gateway.url,
    AUTHORIZER_CACHE_TTL: String(CacheTtl)
};

export {sessionsTable, dataTable, locksTable} from "../dynamodb"
export {pool} from "../cognito"