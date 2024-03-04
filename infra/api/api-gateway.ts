import * as aws from "@pulumi/aws";

export const apiGateway = new aws.apigatewayv2.Api('api', {
    protocolType: "HTTP", // HTTP APIs are quicker and cheaper than REST APIs
    routeSelectionExpression: "${request.method} ${request.path}",
});
