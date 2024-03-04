import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import {apiGateway} from "./api-gateway";
import {authorizer} from "./authorizer";
import {LambdaHandler} from "../../billntip-lambdas";
import {createLambda} from "../lambda";
import {givePermission, makeTableAccess} from "../permissions";
import {dataTable} from "../dynamodb";

const apiServiceLambda = createLambda(
    LambdaHandler.ApiHandler,
    {},
    {},
    [makeTableAccess(dataTable)]);
givePermission(apiServiceLambda, apiGateway)
const integration = new aws.apigatewayv2.Integration("api-service-integration", {
    apiId: apiGateway.id,
    integrationType: "AWS_PROXY", // AWS_PROXY for Lambda function integration
    integrationUri: apiServiceLambda.function.arn,
    requestParameters: {
        "overwrite:header.Set-Cookie": "$context.authorizer.new_cookie",
        //Operations on Authorization header restricted by AWS API.
        "overwrite:header.X-AccessToken": "$context.authorizer.access_token",
        "overwrite:header.X-IdToken": "$context.authorizer.id_token"
    },
    payloadFormatVersion: "2.0"
});
export const apiRoute = new aws.apigatewayv2.Route("api-routing", {
    apiId: apiGateway.id,
    routeKey: "$default",
    target: pulumi.interpolate`integrations/${integration.id}`,
    authorizationType: "CUSTOM",
    authorizerId: authorizer.id
});
