
// Create an email identity for SES
import * as aws from "@pulumi/aws";

new aws.ses.EmailIdentity('cognito-email-identity', {
    email: 'hello@billntip.com',
});