import {allowCrud, locksTable, sessionsTable} from "@aws/dynamodb";
import {LambdaFunction, newApiGwIntegration, newPolicy} from "@aws/util";
import cognito from "@aws/cognito";
import {Lambdas} from "@aws/lambdas";
import * as aws from "@pulumi/aws";
import gateway from "./gateway"
import {LambdaSource} from "@app/lambda/builder";
import * as pulumi from "@pulumi/pulumi";
import {domain, region} from "@aws/api/config";
import apiClient from "@aws/api/cognito-api-client";

const issuer = pulumi.interpolate`https://cognito-idp.${region}.amazonaws.com/${cognito.userPool.id}`
const cognitoDomain = pulumi.interpolate`https://${domain}.auth.${region}.amazoncognito.com`
const accessTokenTtl = apiClient.tokenValidityInSeconds("accessToken");
const idTokenTtl = apiClient.tokenValidityInSeconds("idToken");
if (accessTokenTtl < 180 || idTokenTtl < 180) throw new Error("User Pool Client tokens should last longer than 3 minutes")
const authorizerCacheTtl = accessTokenTtl - 10

const environment = {
    variables: {
        COOKIE_NAME: 'SID',
        SESSION_TABLE: sessionsTable.name,
        LOCKS_TABLE: locksTable.name,
        USER_POOL_ID: cognito.userPool.id,
        OAUTH_CLIENT_ID: apiClient.id, //user pool client id
        OAUTH_ISSUER: issuer,
        OAUTH_TOKEN_ENDPOINT: pulumi.interpolate`${cognitoDomain}/oauth2/token`,
        POST_AUTH_REDIRECT_URL: gateway.url,
        //Cache tokens for almost entire lifetime
        AUTHORIZER_CACHE_TTL: String(authorizerCacheTtl)
    }
};

const authOperation = [
    allowCrud().on(sessionsTable, locksTable).build(),
    newPolicy('UserPoolAccess')
        .allow("cognito-idp:DescribeUserPoolClient")
        .on(cognito.userPool)
        .build()
]

function newAuthLambda(lambda: LambdaSource) {
    return gateway.newLambda(lambda)
        .args({environment})
        .inlinePolicy(...authOperation)
}

const cookieLambda = newAuthLambda(Lambdas['authorizer.cookie'])
    .args({
        memorySize: 256,
        timeout: 5
    })
    .build()


/**
 * Authorizer to use on API routes
 */
const authorizer = new aws.apigatewayv2.Authorizer("cookie-authorizer", {
    name: "user-authorizer",
    apiId: gateway.id,
    authorizerType: "REQUEST",
    enableSimpleResponses: true,
    authorizerUri: cookieLambda.invokeArn,
    authorizerPayloadFormatVersion: "2.0",
    identitySources: ["$request.header.Cookie"],
    authorizerResultTtlInSeconds: authorizerCacheTtl,
});

export default {
    id: authorizer.id,
    name: authorizer.name,
    urn: authorizer.urn,
    authorizerUri: authorizer.authorizerUri,
    src: `${cookieLambda.src.module}/${cookieLambda.src.handler}`,
    gateway,
    /**
     * Create new lambda function performing an auth operation such as checking cookies, performing an OAUTH flow step, etc.
     */
    newAuthLambda,
    /**
     * Creates new integration builder honouring authorizer contract. Specifically the integration
     * converts `$context.authorizer.new_cookie` into `Set-Cookie` header and set authorizer as default for all routes.
     * @param lambda - integration Lambda function
     */
    newAuthorizedIntegration(lambda: LambdaFunction) {
        return newApiGwIntegration(gateway, lambda,
            {
                requestParameters: {
                    "overwrite:header.Set-Cookie": "$context.authorizer.new_cookie",
                }
            })
            .defaults({
                authorizationType: "CUSTOM",
                authorizerId: this.id
            })
    }
}
