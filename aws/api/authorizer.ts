import ddb, {allowCrud} from "@aws/dynamodb";
import {LambdaFunction, newApiGwIntegration, newPolicy} from "@aws/util";
import cognito from "@aws/cognito";
import {Lambdas} from "@aws/lambdas";
import * as aws from "@pulumi/aws";
import gateway from "./gateway"
import {LambdaSource} from "@app/lambda/builder";
import apiClient from "@aws/api/cognito-api-client";

const accessTokenTtl = apiClient.tokenValidityInSeconds("accessToken");
const idTokenTtl = apiClient.tokenValidityInSeconds("idToken");
if (accessTokenTtl < 180 || idTokenTtl < 180) throw new Error("User Pool Client tokens should last longer than 3 minutes")
const authorizerCacheTtl = accessTokenTtl - 10

const authOperation = [
    allowCrud().on(ddb.sessionsTable, ddb.locksTable).buildRoleInlinePolicy('DynamoDbAccess'),
    newPolicy()
        .allow("cognito-idp:DescribeUserPoolClient")
        .on(cognito.userPool)
        .buildRoleInlinePolicy('DescribeUserPoolClient')
]

function newAuthLambda(lambda: LambdaSource) {
    return gateway.newLambda(lambda)
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

function SetCookie(statusCode: number) {
    return {
        statusCode: `${statusCode}`,
        mappings: {
            "overwrite:header.Set-Cookie": "$context.authorizer.new_cookie",
        }
    }
}

export default {
    id: authorizer.id,
    name: authorizer.name,
    urn: authorizer.urn,
    authorizerUri: authorizer.authorizerUri,
    src: `${cookieLambda.src.module}/${cookieLambda.src.handler}`,
    gateway,
    integrationArgs: {
        //Set-Cookie on successful responses if authorizer context has new_cookie value.
        responseParameters: [200, 201, 204, 206].map(SetCookie)
    },
    apiRouteArgs: {
        authorizationType: "CUSTOM",
        authorizerId: authorizer.id
    },
    authorizerCacheTtl,
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
        return newApiGwIntegration(gateway, lambda, this.integrationArgs).defaults(this.apiRouteArgs)
    }
}
