import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {grantInvoke, newLambda, newLambdaRole, newPolicy} from "@aws/util";
import {Lambdas} from "@aws/lambdas";
import ddb, {DynamoDbCRUDActions} from "@aws/dynamodb";
import {configFolder, region, smsExternalId, tags} from "@aws/config"
import {bucket} from "@aws/s3";

const cognitoAssumeRolePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: {
            Service: "cognito-idp.amazonaws.com",
        },
        Condition: {
            StringEquals: {
                "sts:ExternalId": smsExternalId
            }
        }
    }],
});
const smsSenderRole = new aws.iam.Role('cognito-sms-sender-role', {
    assumeRolePolicy: cognitoAssumeRolePolicy,
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

const manageUsersRole = newLambdaRole("cognito-manage-users-role")

const triggers = newLambda(Lambdas['users/cognito-triggers.handler'])
    .args({
        timeout: 10,
        memorySize: 256,
        environment: {
            variables: {
                USERS_TABLE: ddb.usersTable.name,
                LOCKS_TABLE: ddb.locksTable.name,
                BUCKET: bucket.id
            }
        }
    })
    .role(manageUsersRole)
    .build()


const emailIdentity = aws.ses.EmailIdentity.get('userpool-email-identity', 'billntip.com')

const pool = new aws.cognito.UserPool('cognito-user-pool-v3', {
        autoVerifiedAttributes: ['email', 'phone_number'],
        // Configure lambda triggers, such as for custom SMS messages
        lambdaConfig: {
            // You must provide the ARN of the lambda function if you have one
            // customSmsSender: {
            //    lambdaArn: "arn:of:your:lambda:function",
            //    lambdaVersion: "V1_0",
            // },
            preSignUp: triggers.arn,
            postConfirmation: triggers.arn,
            preAuthentication: triggers.arn,
            postAuthentication: triggers.arn,
            preTokenGeneration: triggers.arn,
            customMessage: triggers.arn,
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
            externalId: smsExternalId,
            snsCallerArn: smsSenderRole.arn,
        },
        // Define which attributes can be used to sign in
        //See https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html#user-pool-settings-aliases
        //for discussion of username attributes vs alias attributes
        usernameAttributes: ["email", "phone_number"],

        schemas: [
            {name: "tos", attributeDataType: "String", mutable: true},
            {name: "nationality", attributeDataType: "String", mutable: true},
            {name: "data", attributeDataType: "String", mutable: true},
            {name: "uid", attributeDataType: "String", mutable: true},
        ],

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
        emailConfiguration: {
            sourceArn: emailIdentity.arn,
            emailSendingAccount: 'DEVELOPER',
            fromEmailAddress: 'no-reply@billntip.com'
        },
        // Define MFA and verification configurations
        mfaConfiguration: "OPTIONAL",
        smsAuthenticationMessage: "Your authentication code is {####}.",
        // Customizable email and SMS verification messages
        emailVerificationMessage: "Your verification code is {####}.",
        emailVerificationSubject: "Your verification code",
        smsVerificationMessage: "Your verification code is {####}.",
        tags,
    },
    {retainOnDelete: true})

const accountId = aws.getCallerIdentity().then(x => x.accountId)
const manageUsersPolicy = new aws.iam.Policy("cognito-manage-users-policy", {
    namePrefix: "ManageUsers",
    policy: newPolicy()
        .sid("Cognito")
        .allow(
            "cognito-idp:ListUsers",
            "cognito-idp:AdminUpdateUserAttributes",
            "cognito-idp:AdminCreateUser",
            "cognito-idp:AdminSetUserPassword",
            "cognito-idp:AdminLinkUserAccounts",
            "cognito-idp:AdminListGroupsForUser",
            "cognito-idp:AdminAddUserToGroup",
        )
        .on(pool)
        .sid("DynamoDB").allow(...DynamoDbCRUDActions).on(ddb.usersTable, ddb.locksTable)
        .sid("S3Access").allow('s3:GetObject').on(pulumi.interpolate`${bucket.arn}/templates/*`)
        .sid("SSM").allow('ssm:GetParameters').on(pulumi.interpolate`arn:aws:ssm:${region}:${accountId}:parameter/${configFolder}/*`)
        .buildPolicy()
})

export const triggersPolicy = new aws.iam.RolePolicyAttachment("cognito-manage-users-policy-attachment", {
    role: manageUsersRole,
    policyArn: manageUsersPolicy.arn
})

const recipients = new aws.cognito.UserGroup("cognito-recipient-group", {
    name: "recipient",
    userPoolId: pool.id,
    description: "Recipients are users who can receive tips with Tip app."
}, {retainOnDelete: true})

const business = new aws.cognito.UserGroup("cognito-business-group", {
    name: "business",
    userPoolId: pool.id,
    description: "Businesses are users who can create and manage organisation in Bill app."
}, {retainOnDelete: true})

const admins = new aws.cognito.UserGroup("cognito-admin-group", {
    name: "admin",
    userPoolId: pool.id,
    description: "Admins are users who can manage both Bill and Tip applications",
}, {retainOnDelete: true})

const userPool = {
    type: "userpool",
    id: pool.id,
    arn: pool.arn,
    principal: "cognito-idp.amazonaws.com",
    sourceArn: pool.arn,
    urn: pool.urn,
    triggersRole: manageUsersRole.arn,
    triggersPolicy: manageUsersPolicy.arn,
    triggersPolicyAttachment: triggersPolicy.id,
    groups: [recipients.id, business.id, admins.id]
}
grantInvoke(triggers, userPool)

export default userPool