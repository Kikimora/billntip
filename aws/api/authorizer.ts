import * as aws from "@pulumi/aws";
import {createLambda, givePermission, makeDynamoDbAccess, makeUserPoolAccess, LambdaHandler} from "../lambda";
import {AuthEnv, CacheTtl, pool, locksTable, sessionsTable} from "./env";
import {gateway} from "./gateway";

const cookieLambda = createLambda(
    LambdaHandler.AuthCookieHandler,
    AuthEnv,
    {
        memorySize: 256,
        timeout: 5
    },
    [makeDynamoDbAccess(locksTable.arn, sessionsTable.arn), makeUserPoolAccess(pool.arn)])
givePermission(cookieLambda, gateway)
/**
 * Authorizer to use on API routes
 */
export const authorizer = new aws.apigatewayv2.Authorizer("cookie-authorizer", {
    name: "user-authorizer",
    apiId: gateway.id,
    authorizerType: "REQUEST",
    enableSimpleResponses: true,
    authorizerUri: cookieLambda.function.invokeArn,
    authorizerPayloadFormatVersion: "2.0",
    identitySources: ["$request.header.Cookie"],
    authorizerResultTtlInSeconds: CacheTtl,
});

