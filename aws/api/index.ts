import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import gateway from "./gateway";
import authorizer from "./authorizer";
import apiRoute from "./$default";
import {callbackRoute, tokensRoute} from "./auth";
import tip from "./tip";
import bill from "./bill";
import users from "./users";
import cognitoApiClient from "./cognito-api-client";
import cognitoFrontendClient from "./cognito-frontend-client";

const routes = [
    ...apiRoute.routes,
    ...tokensRoute.routes,
    ...callbackRoute.routes,
    ...tip.routes,
    ...bill.routes,
    ...users.routes
];
const deployment = new aws.apigatewayv2.Deployment(
    "api-deployment",
    {
        apiId: gateway.id,
    },
    {
        dependsOn: routes
    });

if (pulumi.getStack() === "prod") {
    new aws.apigatewayv2.Stage("api-stage", {
        apiId: gateway.id,
        name: "$default",
        deploymentId: deployment.id,
        autoDeploy: false,
    });

    const config = new pulumi.Config();
    const domain = config.get('domain');
    const apiDomainUrl = `api.${domain}`;

    const certificate = new aws.acm.Certificate("cert", {
        domainName: apiDomainUrl,
        validationMethod: "DNS",
    });

    new aws.acm.CertificateValidation("cert-validation", {
        certificateArn: certificate.arn,
    });

    new aws.apigatewayv2.DomainName("api-domain", {
        domainName: apiDomainUrl,
        domainNameConfiguration: {
            certificateArn: certificate.arn,
            endpointType: "REGIONAL",
            securityPolicy: "TLS_1_2"
        }
    });

    new aws.apigatewayv2.ApiMapping("api-domain-mapping", {
        apiId: gateway.id,
        stage: "$default",
        domainName: apiDomainUrl
    });
} else {
    new aws.apigatewayv2.Stage("api-stage", {
        apiId: gateway.id,
        name: pulumi.getStack(),
        autoDeploy: true
    });
}


export const cognitoClients = {
    api: cognitoApiClient,
    frontend: cognitoFrontendClient
}

export default {
    gateway: {
        id: gateway.id,
        url: gateway.url,
        urn: gateway.urn
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
    deployment: {
        id: deployment.id,
        urn: deployment.urn,
        autoDeployed: deployment.autoDeployed,
        triggers: deployment.triggers
    }
}