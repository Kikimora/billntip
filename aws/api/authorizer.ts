import * as aws from "@pulumi/aws";
import {newLambda} from "@aws/util";
import {Lambdas} from "@aws/lambdas";
import * as gateway from "./gateway";
import {authOperation, authorizerCacheTtl, environment} from "./auth/settings";

const cookieLambda = newLambda(Lambdas['authorizer.cookie'])
    .args({
        environment,
        memorySize: 256,
        timeout: 5
    })
    .inlinePolicy(...authOperation)
    .grantInvoke(gateway)
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

export const {id, name} = authorizer


