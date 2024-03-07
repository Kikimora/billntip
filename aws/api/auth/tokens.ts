import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {newLambda} from "@aws/util";
import * as authorizer from "../authorizer";
import * as gateway from "../gateway";
import {Lambdas} from "@aws/lambdas";
import {environment} from "./settings";

const tokensLambda = newLambda(Lambdas['authorizer.tokens'])
    .args({
        environment,
        timeout: 5
    })
    .grantInvoke(gateway)
    .build()

const authTokenIntegration = new aws.apigatewayv2.Integration("api-auth-tokens-integration", {
    apiId: gateway.id,
    integrationType: "AWS_PROXY", // AWS_PROXY for Lambda function integration
    integrationUri: tokensLambda.arn,
    payloadFormatVersion: "2.0"
});
export const tokensRoute = new aws.apigatewayv2.Route("api-auth-tokens-route", {
    apiId: gateway.id,
    routeKey: `GET /auth/tokens`,
    target: pulumi.interpolate`integrations/${authTokenIntegration.id}`,
    authorizationType: "CUSTOM",
    authorizerId: authorizer.id
});
