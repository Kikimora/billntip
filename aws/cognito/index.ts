import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {configFolder, region} from "@aws/config";
import userPool from "./userpool";
import userPoolDomain from "./domain";
import {appleIdp, facebookIdp, googleIdp} from "./idps";

const issuer = pulumi.interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`
const cognitoDomain = pulumi.interpolate`https://${userPoolDomain.domain}.auth.${region}.amazoncognito.com`
const config = new aws.ssm.Parameter("oidc-config", {
    name: `${configFolder}/oidc`,
    type: "String",
    value: pulumi.jsonStringify({
        userPoolId: userPool.id,
        issuer: issuer,
        tokenEndpoint: pulumi.interpolate`${cognitoDomain}/oauth2/token`,
    })
})

export default {

    /**
     * Cognito user pool
     */
    userPool,
    /**
     * Cognito user pool domain
     */
    userPoolDomain,

    config: config.arn,

    identityProviders: {
        apple: {
            name: appleIdp.providerName,
            urn: appleIdp.urn
        },
        facebook: {
            name: facebookIdp.providerName,
            urn: facebookIdp.urn
        },
        google: {
            name: googleIdp.providerName,
            urn: googleIdp.urn
        }
    }
}