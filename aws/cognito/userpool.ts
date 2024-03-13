import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {grantInvoke, newLambda} from "@aws/util";
import {Lambdas} from "@aws/lambdas";

const config = new pulumi.Config();

const externalId = config.get('cognito-sms-external-id')!
const smsSenderRole = new aws.iam.Role('cognito-sms-sender-role', {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: {
                Service: "cognito-idp.amazonaws.com",
            },
            Condition: {
                StringEquals: {
                    "sts:ExternalId": externalId
                }
            }
        }],
    }),
    inlinePolicies: [
        {
            name: 'SNSPublish',
            policy: JSON.stringify({
                Version: "2012-10-17",
                Statement: [{
                    Effect: "Allow",
                    Action: ["sns:publish"],
                    Resource: '*',
                }],
            })
        }
    ]
})

const preSignup = newLambda(Lambdas['users.preSignup']).build()

const pool = new aws.cognito.UserPool('cognito-user-pool', {
    autoVerifiedAttributes: ['email', 'phone_number'],
    // Configure lambda triggers, such as for custom SMS messages
    lambdaConfig: {
        // You must provide the ARN of the lambda function if you have one
        // customSmsSender: {
        //    lambdaArn: "arn:of:your:lambda:function",
        //    lambdaVersion: "V1_0",
        // },
        preSignUp: preSignup.arn
    },
    // Define password policy
    passwordPolicy: {
        minimumLength: 6,
        requireNumbers: true,
        requireSymbols: true,
        requireLowercase: true,
        requireUppercase: true,
        temporaryPasswordValidityDays: 7
    },
    // SMS configuration details
    smsConfiguration: {
        externalId: externalId,
        snsCallerArn: smsSenderRole.arn,
    },
    // Define which attributes can be used to sign in
    usernameAttributes: ["email", "phone_number"],
    // Customizes the user invitation message if you're using adminCreateUser
    adminCreateUserConfig: {
        inviteMessageTemplate: {
            smsMessage: "Your username is {username} and temporary password is {####}.",
            emailMessage: "Your username is {username} and temporary password is {####}.",
            emailSubject: "Your temporary password",
        },
        allowAdminCreateUserOnly: false,
    },
    userAttributeUpdateSettings: {
        attributesRequireVerificationBeforeUpdates: ["email", "phone_number"]
    },
    // Define MFA and verification configurations
    mfaConfiguration: "OPTIONAL",
    smsAuthenticationMessage: "Your authentication code is {####}.",
    // Customizable email and SMS verification messages
    emailVerificationMessage: "Your verification code is {####}.",
    emailVerificationSubject: "Your verification code",
    smsVerificationMessage: "Your verification code is {####}.",
    schemas: [{
        name: "country",
        attributeDataType: "String",
        mutable: true
    }]
})


export const userPool = {
    type: "userpool",
    id: pool.id,
    arn: pool.arn,
    principal: "cognito-idp.amazonaws.com",
    sourceArn: pool.arn,
}
grantInvoke(preSignup, userPool)

new aws.cognito.UserGroup("cognito-recipient-group", {
    name: "recipient",
    userPoolId: userPool.id,
    description: "Recipients are users who can receive tips with Tip app."
})

new aws.cognito.UserGroup("cognito-business-group", {
    name: "business",
    userPoolId: userPool.id,
    description: "Businesses are users who can create and manage organisation in Bill app."
})

new aws.cognito.UserGroup("cognito-admin-group", {
    name: "admin",
    userPoolId: userPool.id,
    description: "Admins are users who can manage both Bill and Tip applications",
})