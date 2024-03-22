
import * as aws from "@pulumi/aws";
import userPool from "./userpool";

// Create a domain for the User Pool to enable the hosted UI feature
const userPoolDomain = new aws.cognito.UserPoolDomain("cognito-hosted-ui-domain", {
    domain: "billntip",  // This should be a unique domain prefix
    userPoolId: userPool.id,
});

export default {
    certificateArn: userPoolDomain.certificateArn,
    cloudfrontDistribution: userPoolDomain.cloudfrontDistribution,
    domain: userPoolDomain.domain,
    id: userPoolDomain.id,
    s3Bucket: userPoolDomain.s3Bucket,
    urn: userPoolDomain.urn
}