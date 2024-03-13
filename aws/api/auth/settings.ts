import * as pulumi from "@pulumi/pulumi";
import * as gateway from "@aws/api/gateway";
import {locksTable, sessionsTable} from "@aws/dynamodb";
import {apiClient, domain, pool, tokenValidityInSeconds} from "@aws/cognito";
import {newPolicy} from "@aws/util";
import {allowDynamoDb} from "@aws/lambdas";

const config = new pulumi.Config("aws")
const region = config.get("region")
const issuer = pulumi.interpolate`https://cognito-idp.${region}.amazonaws.com/${pool.id}`
const cognitoDomain = pulumi.interpolate`https://${domain}.auth.${region}.amazoncognito.com`

const accessTokenTtl = tokenValidityInSeconds("accessToken");
const idTokenTtl = tokenValidityInSeconds("idToken");
if (accessTokenTtl < 180 || idTokenTtl < 180) throw new Error("User Pool Client tokens should last longer than 3 minutes")

export const authorizerCacheTtl = accessTokenTtl - 10

export const environment = {
    variables: {
        COOKIE_NAME: 'SID',
        SESSION_TABLE: sessionsTable.name,
        LOCKS_TABLE: locksTable.name,
        USER_POOL_ID: pool.id,
        OAUTH_CLIENT_ID: apiClient.id, //user pool client id
        OAUTH_ISSUER: issuer,
        OAUTH_TOKEN_ENDPOINT: pulumi.interpolate`${cognitoDomain}/oauth2/token`,
        POST_AUTH_REDIRECT_URL: gateway.url,
        //Cache tokens for almost entire lifetime
        AUTHORIZER_CACHE_TTL: String(authorizerCacheTtl)
    }
};

export const authOperation = [
    allowDynamoDb.on(sessionsTable, locksTable).build(),
    newPolicy('UserPoolAccess')
        .allow("cognito-idp:DescribeUserPoolClient")
        .on(pool)
        .build()
]