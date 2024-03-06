import {apiGateway} from "./api-gateway";
import * as aws from "@pulumi/aws";
import {apiUrl} from "./urls";
import {apiRoute} from "./api-impl";
import {callbackRoute} from "./authorizer";
import * as pulumi from "@pulumi/pulumi";

const deployment = new aws.apigatewayv2.Deployment(
    "api-deployment",
    {
        apiId: apiGateway.id,
    },
    {
        dependsOn: [apiRoute, callbackRoute]
    });

export const stackStage = new aws.apigatewayv2.Stage("api-stage", {
    apiId: apiGateway.id,
    name: pulumi.getStack(),
    autoDeploy: true,
    // accessLogSettings: {
    //     destinationArn: "",
    //     format: "JSON"
    // }
});

export const prodStage = new aws.apigatewayv2.Stage("api-default-stage", {
    apiId: apiGateway.id,
    name: "$default",
    deploymentId: deployment.id,
    autoDeploy: false,
    // accessLogSettings: {
    //     destinationArn: "",
    //     format: "JSON"
    // }
});

export {apiUrl, apiGateway, deployment};
