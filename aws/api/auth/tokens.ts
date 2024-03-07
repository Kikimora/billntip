import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {createLambda, givePermission, LambdaHandler} from "../../lambda";
import {authorizer} from "../authorizer";
import {AuthEnv} from "../env";
import {gateway} from "../gateway";

export const tokensLambda = createLambda(LambdaHandler.AuthTokensHandler, AuthEnv, {
    timeout: 5
})
givePermission(tokensLambda, gateway)
const authTokenIntegration = new aws.apigatewayv2.Integration("api-auth-tokens-integration", {
    apiId: gateway.id,
    integrationType: "AWS_PROXY", // AWS_PROXY for Lambda function integration
    integrationUri: tokensLambda.function.arn,
    payloadFormatVersion: "2.0"
});
export const tokensRoute = new aws.apigatewayv2.Route("api-auth-tokens-route", {
    apiId: gateway.id,
    routeKey: `GET /auth/tokens`,
    target: pulumi.interpolate`integrations/${authTokenIntegration.id}`,
    authorizationType: "CUSTOM",
    authorizerId: authorizer.id
});
