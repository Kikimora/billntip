import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {createLambda, givePermission, LambdaHandler, makeDynamoDbAccess, makeUserPoolAccess} from "../../../lambda";
import {gateway} from "../../gateway";
import {AuthEnv, pool, sessionsTable} from "../../env";

const codeLambda = createLambda(
    LambdaHandler.AuthCodeHandler,
    AuthEnv,
    {
        timeout: 10
    },
    [makeDynamoDbAccess(sessionsTable.arn), makeUserPoolAccess(pool.arn)])
givePermission(codeLambda, gateway)

const authCodeIntegration = new aws.apigatewayv2.Integration("api-auth-code-integration", {
    apiId: gateway.id,
    integrationType: "AWS_PROXY", // AWS_PROXY for Lambda function integration
    integrationUri: codeLambda.function.arn,
    payloadFormatVersion: "2.0"
});

export const callbackRoute = new aws.apigatewayv2.Route("api-auth-code-route", {
    apiId: gateway.id,
    routeKey: `GET /${gateway.authCallback}`,
    target: pulumi.interpolate`integrations/${authCodeIntegration.id}`,
    authorizationType: "NONE",
});
