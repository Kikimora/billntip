import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {apiGateway} from "./api-gateway";

const config = new pulumi.Config();
const domain = config.get('domain');

const apiRootPath = `${pulumi.getStack() == "prod" ? "" : pulumi.getStack()}`
export const apiUrl = pulumi.interpolate`${registerApiDomain()}/${apiRootPath}`
export const authCallback = "auth/callback"

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
            apiId: apiGateway.id,
            stage: "$default",
            domainName: apiDomain.domainName,
        });
        return `https://${apiDomainUrl}`
    } else {
        return pulumi.interpolate`${apiGateway.apiEndpoint}`
    }
}
