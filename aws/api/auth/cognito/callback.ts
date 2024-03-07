import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as gateway from "../../gateway";
import {Lambdas} from "@aws/lambdas";
import {environment, authOperation} from "../settings";
import {newLambda} from "@aws/util";

const codeLambda = newLambda(Lambdas['authorizer.code'])
    .args({
        environment,
        timeout: 10
    })
    .inlinePolicy(...authOperation)
    .grantInvoke(gateway)
    .build()

const authCodeIntegration = new aws.apigatewayv2.Integration("api-auth-code-integration", {
    apiId: gateway.id,
    integrationType: "AWS_PROXY", // AWS_PROXY for Lambda function integration
    integrationUri: codeLambda.arn,
    payloadFormatVersion: "2.0"
});

export const callbackRoute = new aws.apigatewayv2.Route("api-auth-code-route", {
    apiId: gateway.id,
    routeKey: `GET /${gateway.authCallback}`,
    target: pulumi.interpolate`integrations/${authCodeIntegration.id}`,
    authorizationType: "NONE",
});
