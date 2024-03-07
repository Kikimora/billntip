import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {gateway} from "../api";
import {createLambda, LambdaHandler, givePermission} from "../lambda";
import {tokenValidity} from "./settings";

const config = new pulumi.Config();

const externalId = config.get('cognito-sms-external-id')!
const smsSenderRole = new aws.iam.Role('users-sms-sender-role', {
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

const preSignup = createLambda(LambdaHandler.UsersPreSignupHandler, {}, {})

export const userPool = new aws.cognito.UserPool('users', {
    autoVerifiedAttributes: ['email', 'phone_number'],
    // Configure lambda triggers, such as for custom SMS messages
    lambdaConfig: {
        // You must provide the ARN of the lambda function if you have one
        // customSmsSender: {
        //    lambdaArn: "arn:of:your:lambda:function",
        //    lambdaVersion: "V1_0",
        // },
        preSignUp: preSignup.function.arn
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
})

// Note - providerName and providerType must match - https://github.com/aws/aws-cli/issues/3179
const facebookIdp = new aws.cognito.IdentityProvider("users-facebook-idp", {
    //providerName MUST be the same as providerType
    providerName: 'Facebook',
    providerType: "Facebook",
    userPoolId: userPool.id,
    providerDetails: {
        client_id: config.require('facebook_client_id'),
        client_secret: config.requireSecret('facebook_client_secret'),
        authorize_scopes: "email,public_profile",
        attributes_url: "https://graph.facebook.com/v17.0/me?fields=",
        attributes_url_add_attributes: "true",
        authorize_url: "https://www.facebook.com/v17.0/dialog/oauth",
        token_request_method: "GET",
        token_url: "https://graph.facebook.com/v17.0/oauth/access_token"
    },
    attributeMapping: {
        email: "email",
        username: "id",
    },
});

const googleIdp = new aws.cognito.IdentityProvider("users-google-idp", {
    //providerName MUST be the same as providerType
    providerName: 'Google',
    providerType: "Google",
    userPoolId: userPool.id,
    providerDetails: {
        client_id: config.require('google_client_id'),
        client_secret: config.requireSecret('google_client_secret'),
        authorize_scopes: "openid email profile",
        attributes_url: "https://people.googleapis.com/v1/people/me?personFields=",
        attributes_url_add_attributes: "true",
        authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
        oidc_issuer: "https://accounts.google.com",
        token_request_method: "POST",
        token_url: "https://www.googleapis.com/oauth2/v4/token"
    },
    attributeMapping: {
        email: "email",
        username: "sub",
    },
});

const appleIdp = new aws.cognito.IdentityProvider("users-apple-idp", {
    //providerName MUST be the same as providerType
    providerName: 'SignInWithApple',
    providerType: 'SignInWithApple',
    userPoolId: userPool.id,
    attributeMapping: {
        email: 'email',
        name: 'name',
        username: "sub"
    },
    providerDetails: {
        client_id: config.require('apple_client_id'),
        team_id: config.require('apple_team_id'),
        key_id: config.require('apple_key_id'),
        private_key: config.requireSecret('apple_private_key'),
        attributes_url_add_attributes: "false",
        authorize_url: "https://appleid.apple.com/auth/authorize",
        oidc_issuer: "https://appleid.apple.com",
        token_request_method: "POST",
        token_url: "https://appleid.apple.com/auth/token"
    },
    idpIdentifiers: [],
});

// Create a domain for the User Pool to enable the hosted UI feature
export const userPoolDomain = new aws.cognito.UserPoolDomain("users-hosted-ui", {
    domain: "billntip",  // This should be a unique domain prefix
    userPoolId: userPool.id,
});

export const userPoolClient = new aws.cognito.UserPoolClient("users-api-client", {
    userPoolId: userPool.id,
    allowedOauthFlows: ["code"],
    allowedOauthScopes: ["phone", "email", "openid", "profile", "aws.cognito.signin.user.admin"],
    //Notes:
    //If generateSecret is true then AdminInitiateLogin wants SECRET_HASH
    generateSecret: true,
    //Client credentials grant type disabled if using hosted UI. Can be enabled after creation.
    //Also client_credentials seem to require `generateSecret` which complicate admin login.
    //allowedOauthFlows: ["code", "client_credentials"],
    callbackUrls: [
        pulumi.interpolate`${gateway.url}/${gateway.authCallback}`,
    ],
    allowedOauthFlowsUserPoolClient: true,
    explicitAuthFlows: ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"],
    ...tokenValidity,
    supportedIdentityProviders: [
        "COGNITO",
        googleIdp.providerName,
        facebookIdp.providerName,
        appleIdp.providerName
    ],

}, {ignoreChanges: ['callbackUrls']});


export const pool = {
    type: "userpool",
    id: userPool.id,
    arn: userPool.arn,
    principal: "cognito-idp.amazonaws.com",
    sourceArn: userPool.arn,
}
givePermission(preSignup, pool)

// Create an email identity for SES
new aws.ses.EmailIdentity('users-hello-email-identity', {
    email: 'hello@billntip.com',
});