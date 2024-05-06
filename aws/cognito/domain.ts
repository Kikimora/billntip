import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import userPool from "./userpool";

const domain = pulumi.getStack() == 'prod' ? 'billntip' : `billntip-${pulumi.getStack()}`
//Domain is required for hosted UI and OAuth endpoints
const userPoolDomain = new aws.cognito.UserPoolDomain("cognito-hosted-ui-domain", {
    domain,
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