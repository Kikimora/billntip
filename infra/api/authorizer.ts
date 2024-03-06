import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import {tokenValidityInSeconds, userPool, userPoolClient, userPoolDomain} from "../cognito"
import {locksTable, sessionsTable} from "../dynamodb";
import {apiGateway} from "./api-gateway";
import {apiUrl, authRoot, cognitoCallback} from "./urls";
import {LambdaHandler} from "../../billntip-lambdas";
import {createLambda} from "../lambda";
import {givePermission, makeDynamoDbAccess, makeUserPoolAccess} from "../permissions";

const config = new pulumi.Config("aws")
const region = config.get("region")

const accessTokenTtl = tokenValidityInSeconds("accessToken");
const idTokenTtl = tokenValidityInSeconds("idToken");
if (accessTokenTtl < 180 || idTokenTtl < 180) throw new Error("User Pool Client tokens should last longer than 3 minutes")
//Cache tokens for almost entire lifetime
const cacheTtl = accessTokenTtl - 10;
const issuer = pulumi.interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`
const cognitoDomain = pulumi.interpolate`https://${userPoolDomain.domain}.auth.${region}.amazoncognito.com`

const env = {
    COOKIE_NAME: 'JSESSIONID',
    SESSION_TABLE: sessionsTable.name,
    LOCKS_TABLE: locksTable.name,
    USER_POOL_ID: userPool.id,
    OAUTH_CLIENT_ID: userPoolClient.id, //user pool client id
    OAUTH_ISSUER: issuer,
    OAUTH_TOKEN_ENDPOINT: pulumi.interpolate`${cognitoDomain}/oauth2/token`,
    POST_AUTH_REDIRECT_URL: apiUrl,
    AUTHORIZER_CACHE_TTL: String(cacheTtl)
};
export const cookieLambda = createLambda(
    LambdaHandler.AuthCookieHandler,
    env,
    {
        memorySize: 256,
        timeout: 5
    },
    [makeDynamoDbAccess(locksTable, sessionsTable), makeUserPoolAccess(userPool)])
givePermission(cookieLambda, apiGateway)
/**
 * Authorizer to use on API routes
 */
export const authorizer = new aws.apigatewayv2.Authorizer("cookie-authorizer", {
    name: "user-authorizer",
    apiId: apiGateway.id,
    authorizerType: "REQUEST",
    enableSimpleResponses: true,
    authorizerUri: cookieLambda.function.invokeArn,
    authorizerPayloadFormatVersion: "2.0",
    identitySources: ["$request.header.Cookie"],
    authorizerResultTtlInSeconds: cacheTtl,
});

//GET /auth/callback
export const codeLambda = createLambda(
    LambdaHandler.AuthCodeHandler,
    env,
    {
        timeout: 10
    },
    [makeDynamoDbAccess(sessionsTable), makeUserPoolAccess(userPool)])
givePermission(codeLambda, apiGateway)
const authCodeIntegration = new aws.apigatewayv2.Integration("api-auth-code-integration", {
    apiId: apiGateway.id,
    integrationType: "AWS_PROXY", // AWS_PROXY for Lambda function integration
    integrationUri: codeLambda.function.arn,
    payloadFormatVersion: "2.0"
});
export const callbackRoute = new aws.apigatewayv2.Route("api-auth-code-route", {
    apiId: apiGateway.id,
    routeKey: `GET /${cognitoCallback}`,
    target: pulumi.interpolate`integrations/${authCodeIntegration.id}`,
    authorizationType: "NONE",
});

//GET /auth/tokens
export const tokensLambda = createLambda(LambdaHandler.AuthTokensHandler, env, {
    timeout: 5
})
givePermission(tokensLambda, apiGateway)
const authTokenIntegration = new aws.apigatewayv2.Integration("api-auth-tokens-integration", {
    apiId: apiGateway.id,
    integrationType: "AWS_PROXY", // AWS_PROXY for Lambda function integration
    integrationUri: tokensLambda.function.arn,
    payloadFormatVersion: "2.0"
});
export const tokensRoute = new aws.apigatewayv2.Route("api-auth-tokens-route", {
    apiId: apiGateway.id,
    routeKey: `GET /${authRoot}/tokens`,
    target: pulumi.interpolate`integrations/${authTokenIntegration.id}`,
    authorizationType: "CUSTOM",
    authorizerId: authorizer.id
});
