import {apiGateway} from "./api/api-gateway";
import * as aws from "@pulumi/aws";
import {apiUrl} from "./api/urls";
import {apiRoute} from "./api/api-impl";
import {callbackRoute} from "./api/authorizer";
import * as pulumi from "@pulumi/pulumi";

const deployment = new aws.apigatewayv2.Deployment(
    "api-deployment",
    {
        apiId: apiGateway.id,
    },
    {
        dependsOn: [apiRoute, callbackRoute]
    });

export const stage = new aws.apigatewayv2.Stage("api-stage", {
    apiId: apiGateway.id,
    deploymentId: deployment.id,
    name: pulumi.getStack() == "prod" ? "$default" : pulumi.getStack(),
    autoDeploy: true,
    // accessLogSettings: {
    //     destinationArn: "",
    //     format: "JSON"
    // }
});

export {apiUrl, apiGateway, deployment};
