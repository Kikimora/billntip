import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {FunctionArgs} from "@pulumi/aws/lambda";
import {LambdaHandler, makeResourceId} from "../../billntip-lambdas";
import {makeLambdaName, createLambda, LambdaEnvironment} from "../src";

export const apiGateway = new aws.apigatewayv2.Api('api', {
    protocolType: "HTTP", // HTTP APIs are quicker and cheaper than REST APIs
    routeSelectionExpression: "${request.method} ${request.path}",
});

/**
 * Create a Lambda function and grant API WG permission to call it.
 **/
export function makeApiLambda(handler: LambdaHandler, env: LambdaEnvironment, args: Partial<FunctionArgs>) {
    const lambda = createLambda(handler, env, args)
    const id = makeResourceId(handler)

    new aws.lambda.Permission(`${id}-permissions`, {
        action: "lambda:invokeFunction",
        function: lambda.arn,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${apiGateway.executionArn}/*/*`,
    });

    return lambda
}

