import * as aws from "@pulumi/aws";
import * as gateway from "./gateway";
import {callbackRoute} from "./auth"
import {apiRoute} from "./$default"

export * as authorizer from "./authorizer"
export * as gateway from "./gateway"

const deployment = new aws.apigatewayv2.Deployment(
    "api-deployment",
    {
        apiId: gateway.id,
    },
    {
        dependsOn: [apiRoute, callbackRoute]
    });

new aws.apigatewayv2.Stage("api-stage", {
    apiId: gateway.id,
    name: "dev",
    autoDeploy: true,
    // accessLogSettings: {
    //     destinationArn: "",
    //     format: "JSON"
    // }
});

new aws.apigatewayv2.Stage("api-default-stage", {
    apiId: gateway.id,
    name: "$default",
    deploymentId: deployment.id,
    autoDeploy: false,
    // accessLogSettings: {
    //     destinationArn: "",
    //     format: "JSON"
    // }
});

