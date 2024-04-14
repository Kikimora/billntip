import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {domain} from "./config";
import {newLambda} from "@aws/util";
import {LambdaSource} from "@app/lambda/builder";

const apiGw = new aws.apigatewayv2.Api('api', {
    protocolType: "HTTP", // HTTP APIs are quicker and cheaper than REST APIs
    routeSelectionExpression: "${request.method} ${request.path}",
    corsConfiguration: {
        allowCredentials: true,
        allowHeaders: ['content-type'],
        allowOrigins: pulumi.getStack() === "prod" ? ['https://billntip.com'] : [
            'http://localhost:3006', //local dev
            'http://urbankitchen.domain-for-testing.ru',
        ],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        exposeHeaders: ['*'],
        maxAge: 3600
    }
});

const apiUrl = pulumi.getStack() === "prod" ? `https://api.${domain}` : pulumi.interpolate`${apiGw.apiEndpoint}/${pulumi.getStack()}`
const lambdaCaller = {
    sourceArn: pulumi.interpolate`${apiGw.executionArn}/*/*`,
    principal: "apigateway.amazonaws.com",
}

export default {
    type: "gateway",
    name: "api",
    id: apiGw.id,
    urn: apiGw.urn,
    url: apiUrl,
    authCallbackPath: '/auth/cognito/idpresponse',
    authCallback: pulumi.interpolate`${apiUrl}/auth/cognito/idpresponse`,

    newLambda(lambda: LambdaSource) {
        return newLambda(lambda).grantInvoke(lambdaCaller)
    }
}
