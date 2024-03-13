
import * as aws from "@pulumi/aws";
import {userPool} from "./userpool";

// Create a domain for the User Pool to enable the hosted UI feature
export const userPoolDomain = new aws.cognito.UserPoolDomain("cognito-hosted-ui-domain", {
    domain: "billntip",  // This should be a unique domain prefix
    userPoolId: userPool.id,
});