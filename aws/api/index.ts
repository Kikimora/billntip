import * as aws from "@pulumi/aws";
import gateway from "./gateway";
import authorizer from "./authorizer";
import cognitoApiClient from "./cognito-api-client";
import cognitoFrontendClient from "./cognito-frontend-client";
import {regionalCertificate} from "../certificate"
import {callbackRoute, tokensRoute} from "./auth";
import bill from "./bill";
import images from "./images";
import tip from "./tip";
import users from "./users";
import {configFolder} from "@aws/config";
import * as pulumi from "@pulumi/pulumi";

const config = new aws.ssm.Parameter("api-config", {
    name: `${configFolder}/api`,
    type: "String",
    value: pulumi.jsonStringify({
        cookieName: 'SID',
        sameSite: "none",
        clientId: cognitoApiClient.id, //user pool client id
        postAuthRedirectUrl: gateway.authCallback,
        //Cache tokens for almost entire lifetime
        authorizerCacheTtl: authorizer.authorizerCacheTtl,
    })
})

const routes = [
    ...tokensRoute.routes,
    ...callbackRoute.routes,
    ...tip.routes,
    ...bill.routes,
    ...users.routes,
    ...images.routes,
];
const domainName = new aws.apigatewayv2.DomainName("api-domain", {
    domainName: gateway.apiDomain,
    domainNameConfiguration: {
        certificateArn: regionalCertificate.arn,
        endpointType: "REGIONAL",
        securityPolicy: "TLS_1_2"
    }
})

const stage = new aws.apigatewayv2.Stage("api-stage", {
    apiId: gateway.id,
    name: "$default",
    autoDeploy: true,
})
new aws.apigatewayv2.ApiMapping("api-domain-mapping", {
    apiId: gateway.id,
    stage: stage.id,
    domainName: domainName.domainName
})

export const cognitoClients = {
    api: cognitoApiClient,
    frontend: cognitoFrontendClient
}

export default {
    gateway: {
        id: gateway.id,
        url: gateway.url,
        urn: gateway.urn,
        domain: domainName.domainName
    },
    authorizer: {
        id: authorizer.id,
        name: authorizer.name,
        src: authorizer.src,
        urn: authorizer.urn,
    },
    routes: routes.map(x => ({
        operationName: x.operationName,
        routeKey: x.routeKey,
        authorizerId: x.authorizerId,
        target: x.target,
        src: x.src,
        lambdaArn: x.lambdaArn
    })),
    config: config.arn
}