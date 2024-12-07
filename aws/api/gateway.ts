import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {configFolder, domain, region, stack, tags, apps} from "@aws/config";
import {newLambda, newPolicy} from "@aws/util";
import {LambdaSource} from "@app/lambda/builder";

aws.account

const apiGw = new aws.apigatewayv2.Api('api', {
    name: `billntip-${stack}`,
    protocolType: "HTTP", // HTTP APIs are quicker and cheaper than REST APIs
    routeSelectionExpression: "${request.method} ${request.path}",
    corsConfiguration: {
        allowCredentials: true,
        allowHeaders: ['content-type'],
        allowOrigins: apps.flatMap(function (app) {
            return [`https://${app}.${domain}`, `https://${app}.dev.billntip.com`]
        }),
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        exposeHeaders: ['*'],
        maxAge: 3600
    },
    tags,
});

const apiDomain = `api.${domain}`
const url = `https://${apiDomain}`
const lambdaCaller = {
    sourceArn: pulumi.interpolate`${apiGw.executionArn}/*/*`,
    principal: "apigateway.amazonaws.com",
}

const accountId = aws.getCallerIdentity().then(x => x.accountId)

export default {
    type: "gateway",
    name: "api",
    id: apiGw.id,
    urn: apiGw.urn,
    apiDomain,
    url,
    authCallbackPath: '/auth/cognito/idpresponse',
    authCallback: pulumi.interpolate`${url}/auth/cognito/idpresponse`,

    newLambda(lambda: LambdaSource) {
        return newLambda(lambda)
            .grantInvoke(lambdaCaller)
            .inlinePolicy(newPolicy()
                .allow('ssm:GetParameters')
                .on(pulumi.interpolate`arn:aws:ssm:${region}:${accountId}:parameter/${configFolder}/*`)
                .buildRoleInlinePolicy("SSM")
            )
    }
}
