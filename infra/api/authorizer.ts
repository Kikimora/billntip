import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import {tokenValidityInSeconds, userPool, userPoolClient, userPoolDomain} from "../users"
import {sessionsTable} from "../data";
import {apiGateway, makeApiLambda} from "./api-gateway";
import {apiUrl, authCallback} from "./urls";
import {LambdaHandler} from "../../billntip-lambdas";

const config = new pulumi.Config("aws")
const region = config.get("region")

const cacheTtl = tokenValidityInSeconds("accessToken");
const sessionTtl = tokenValidityInSeconds("refreshToken");
const issuer = pulumi.interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`
const cognitoDomain = pulumi.interpolate`https://${userPoolDomain.domain}.auth.${region}.amazoncognito.com`

const env = {
    COOKIE_NAME: 'JSESSIONID',
    SESSION_TABLE: sessionsTable.name,
    REFRESH_TOKEN_TTL: sessionTtl.toString(),
    CACHE_TTL: cacheTtl.toString(),
    OAUTH_CLIENT_ID: userPoolClient.id, //user pool client id
    OAUTH_ISSUER: issuer,
    OAUTH_TOKEN_ENDPOINT: pulumi.interpolate`${cognitoDomain}/oauth2/token`,
    POST_AUTH_REDIRECT_URL: apiUrl,
};
export const authorizerFunction = makeApiLambda(LambdaHandler.AuthCookieHandler, env, {})
/**
 * Authorizer to use on API routes
 */
export const authorizer = new aws.apigatewayv2.Authorizer("cookie-authorizer", {
    name: "user-authorizer",
    apiId: apiGateway.id,
    authorizerType: "REQUEST",
    enableSimpleResponses: true,
    authorizerUri: authorizerFunction.invokeArn,
    authorizerPayloadFormatVersion: "2.0",
    identitySources: ["$request.header.Cookie"],
    authorizerResultTtlInSeconds: cacheTtl
});

export const authorizationCodeFunction = makeApiLambda(LambdaHandler.AuthCodeHandler, env, {
    timeout: 10
})
const authorizationCodeIntegration = new aws.apigatewayv2.Integration("api-auth-code-integration", {
    apiId: apiGateway.id,
    integrationType: "AWS_PROXY", // AWS_PROXY for Lambda function integration
    integrationUri: authorizationCodeFunction.arn,
    payloadFormatVersion: "2.0"
});
export const callbackRoute = new aws.apigatewayv2.Route("api-auth-callback-route", {
    apiId: apiGateway.id,
    routeKey: `ANY /${authCallback}`,
    target: pulumi.interpolate`integrations/${authorizationCodeIntegration.id}`,
    authorizationType: "NONE",
});
