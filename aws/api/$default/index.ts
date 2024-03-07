import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {newLambda} from "@aws/util";
import * as authorizer from "../authorizer";
import * as gateway from "../gateway";
import {allowDynamoDb, Lambdas} from "@aws/lambdas";
import {dataTable} from "@aws/dynamodb";

const apiServiceLambda = newLambda(Lambdas['api.handler'])
    .args({
        timeout: 5,
        memorySize: 512
    })
    .inlinePolicy(allowDynamoDb.on(dataTable).build())
    .grantInvoke(gateway)
    .build()

const integration = new aws.apigatewayv2.Integration("api-service-integration", {
    apiId: gateway.id,
    integrationType: "AWS_PROXY", // AWS_PROXY for Lambda function integration
    integrationUri: apiServiceLambda.arn,
    requestParameters: {
        "overwrite:header.Set-Cookie": "$context.authorizer.new_cookie",
        //Operations on Authorization header restricted by AWS API.
        "overwrite:header.X-AccessToken": "$context.authorizer.access_token",
        "overwrite:header.X-IdToken": "$context.authorizer.id_token"
    },
    payloadFormatVersion: "2.0"
});
export const apiRoute = new aws.apigatewayv2.Route("api-routing", {
    apiId: gateway.id,
    routeKey: "$default",
    target: pulumi.interpolate`integrations/${integration.id}`,
    authorizationType: "CUSTOM",
    authorizerId: authorizer.id
});
