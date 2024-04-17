import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {grantInvoke, newLambda, newLambdaRole, newPolicy} from "@aws/util";
import {Lambdas} from "@aws/lambdas";
import {UserMigrationTriggerEvent} from "aws-lambda/trigger/cognito-user-pool-trigger/user-migration";
import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import _ from "lodash";

const config = new pulumi.Config();

const externalId = config.get('cognito-sms-external-id')!
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
                "sts:ExternalId": externalId
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
const preSignup = newLambda(Lambdas['cognito-triggers.preSignup'])
    .args({timeout: 10})
    .role(manageUsersRole)
    .build()
const postSignup = newLambda(Lambdas['cognito-triggers.postSignup'])
    .args({timeout: 10})
    .role(manageUsersRole)
    .build()
const info = newLambda(Lambdas['cognito-triggers.info'])
    .args({timeout: 10})
    .role(manageUsersRole)
    .build()
const preTokenGeneration = newLambda(Lambdas['cognito-triggers.preTokenGeneration'])
    .args({timeout: 10})
    .role(manageUsersRole)
    .build()
const postAuthentication = newLambda(Lambdas['cognito-triggers.postAuthentication'])
    .args({timeout: 10})
    .role(manageUsersRole)
    .build()

const sourcePoolId = "eu-south-1_deiDICPWm"
const sourcePoolArn = "arn:aws:cognito-idp:eu-south-1:381491945919:userpool/eu-south-1_deiDICPWm"
const migrateUsers = new aws.lambda.CallbackFunction("migrate", {
    role: manageUsersRole,
    callback: async function (e: UserMigrationTriggerEvent) {
        const cognito = new CognitoIdentityProvider()
        console.log("Started", e)
        if (e.userPoolId === sourcePoolId) return

        const {userPoolId, userName} = e
        const oldUser = await cognito.adminGetUser({
            UserPoolId: sourcePoolId,
            Username: userName
        })
        const groups = await cognito.adminListGroupsForUser({
            UserPoolId: sourcePoolId,
            Username: userName
        })
        console.log("Migrate user", oldUser, " with groups ", groups)

        //Move old attributes
        const attrs = _.keyBy(oldUser.UserAttributes, 'Name')
        attrs['custom:tos'] = attrs['custom:tos1'] ?? attrs['custom:tos']
        attrs['custom:nationality'] = attrs['custom:nationality1'] ?? attrs['custom:nationality']
        attrs['custom:data'] = attrs['custom:data1'] ?? attrs['custom:data']
        attrs['custom:uid'] = attrs['custom:uid'] ?? {Name: 'custom:uid', Value: attrs['sub'].Value}
        delete attrs.sub

        const userAttributes = _(attrs).values().compact().value()
        console.log("User Attributes", attrs, userAttributes)

        try {
            await cognito.adminCreateUser({
                UserPoolId: userPoolId,
                Username: userName,
                UserAttributes: userAttributes,
                MessageAction: "SUPPRESS",
                ValidationData: _.map(e.request.validationData, function (v, k) {
                    return {Name: k, Value: v}
                }),
                ClientMetadata: e.request.clientMetadata
            })
            await cognito.adminSetUserPassword({
                UserPoolId: userPoolId,
                Username: userName,
                Password: e.request.password,
                Permanent: true
            })
        } catch (e: any) {
            if (e.name !== 'UsernameExistsException') {
                throw e
            }
            console.warn("Username already exists in the target pool", e)
            const {UserAttributes: existingAttributes} = await cognito.adminGetUser({
                UserPoolId: userPoolId,
                Username: userName
            })
            _.merge(existingAttributes, attrs)
            await cognito.adminUpdateUserAttributes({
                UserPoolId: userPoolId,
                Username: userName,
                UserAttributes: _.values(existingAttributes)
            })
        }

        if (groups.Groups !== undefined) {
            for (const g of groups.Groups) {
                console.log("Adding user to group", g)
                await cognito.adminAddUserToGroup({
                    UserPoolId: userPoolId,
                    Username: userName,
                    GroupName: g.GroupName
                })
            }
        }

        e.response.finalUserStatus = "CONFIRMED";
        e.response.messageAction = "SUPPRESS";

        return e
    }
});

const pool = new aws.cognito.UserPool('cognito-user-pool-v3', {
    autoVerifiedAttributes: ['email', 'phone_number'],
    // Configure lambda triggers, such as for custom SMS messages
    lambdaConfig: {
        // You must provide the ARN of the lambda function if you have one
        // customSmsSender: {
        //    lambdaArn: "arn:of:your:lambda:function",
        //    lambdaVersion: "V1_0",
        // },
        preSignUp: preSignup.arn,
        postConfirmation: postSignup.arn,
        preAuthentication: info.arn,
        postAuthentication: postAuthentication.arn,
        preTokenGeneration: info.arn,

        userMigration: migrateUsers.arn
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
    // Define MFA and verification configurations
    mfaConfiguration: "OPTIONAL",
    smsAuthenticationMessage: "Your authentication code is {####}.",
    // Customizable email and SMS verification messages
    emailVerificationMessage: "Your verification code is {####}.",
    emailVerificationSubject: "Your verification code",
    smsVerificationMessage: "Your verification code is {####}."
}, {retainOnDelete: true})

const userPool = {
    type: "userpool",
    id: pool.id,
    arn: pool.arn,
    principal: "cognito-idp.amazonaws.com",
    sourceArn: pool.arn,
    urn: pool.urn
}
grantInvoke(preSignup, userPool)
grantInvoke(postSignup, userPool)
grantInvoke(info, userPool)
grantInvoke(preTokenGeneration, userPool)
grantInvoke(postAuthentication, userPool)
grantInvoke({id: 'migrate', arn: migrateUsers.arn}, userPool)

export default userPool

const args = {
    ...newPolicy("ManageUsers")
        .allow(
            "cognito-idp:ListUsers",
            "cognito-idp:AdminUpdateUserAttributes",
            "cognito-idp:AdminCreateUser",
            "cognito-idp:AdminSetUserPassword",
            "cognito-idp:AdminLinkUserAccounts",
            "cognito-idp:AdminListGroupsForUser",
            "cognito-idp:AdminAddUserToGroup",
        ).on(pool, sourcePoolArn)
        .buildRoleInlinePolicy()
};
const manageUsersPolicy = new aws.iam.Policy("cognito-manage-users-policy", args)

new aws.iam.RolePolicyAttachment("cognito-manage-users-policy-attachment", {
    role: manageUsersRole,
    policyArn: manageUsersPolicy.arn
})

new aws.cognito.UserGroup("cognito-recipient-group", {
    name: "recipient",
    userPoolId: userPool.id,
    description: "Recipients are users who can receive tips with Tip app."
}, {retainOnDelete: true})

new aws.cognito.UserGroup("cognito-business-group", {
    name: "business",
    userPoolId: userPool.id,
    description: "Businesses are users who can create and manage organisation in Bill app."
}, {retainOnDelete: true})

new aws.cognito.UserGroup("cognito-admin-group", {
    name: "admin",
    userPoolId: userPool.id,
    description: "Admins are users who can manage both Bill and Tip applications",
}, {retainOnDelete: true})