import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const apiGw = new aws.apigatewayv2.Api('api', {
    protocolType: "HTTP", // HTTP APIs are quicker and cheaper than REST APIs
    routeSelectionExpression: "${request.method} ${request.path}",
});

const config = new pulumi.Config();
const domain = config.get('domain');

const apiRootPath = `${pulumi.getStack() == "prod" ? "" : pulumi.getStack()}`

function registerApiDomain() {
    if (domain != null && domain != '') {
        const apiDomainUrl = `api.${domain}`;
        const certificate = new aws.acm.Certificate("cert", {
            domainName: apiDomainUrl,
            validationMethod: "DNS",
        });
        new aws.acm.CertificateValidation("cert-validation", {
            certificateArn: certificate.arn,
        });
        const apiDomain = new aws.apigatewayv2.DomainName("api-domain", {
            domainName: apiDomainUrl,
            domainNameConfiguration: {
                certificateArn: certificate.arn,
                endpointType: "REGIONAL",
                securityPolicy: "TLS_1_2"
            }

        });
        new aws.apigatewayv2.ApiMapping("api-domain-mapping", {
            apiId: apiGw.id,
            stage: "$default",
            domainName: apiDomain.domainName,
        });
        return `https://${apiDomainUrl}`
    } else {
        return pulumi.interpolate`${apiGw.apiEndpoint}`
    }
}

export const gateway = {
    type: "gateway",
    id: apiGw.id,
    url: pulumi.interpolate`${registerApiDomain()}/${apiRootPath}`,
    authCallback: `auth/cognito/idpresponse`,
    principal: "apigateway.amazonaws.com",
    sourceArn: pulumi.interpolate`${apiGw.executionArn}/*/*`
}
