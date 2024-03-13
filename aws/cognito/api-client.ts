import * as aws from "@pulumi/aws";
import {userPool} from "./userpool";
import {callbackUrl, tokenValidity} from "./settings";
import {appleIdp, facebookIdp, googleIdp} from "./idps";

export const apiClient = new aws.cognito.UserPoolClient("cognito-api-client", {
    userPoolId: userPool.id,
    allowedOauthFlows: ["code"],
    allowedOauthScopes: ["phone", "email", "openid", "profile", "aws.cognito.signin.user.admin"],
    //Notes:
    //If generateSecret is true then AdminInitiateLogin wants SECRET_HASH
    generateSecret: true,
    //Client credentials grant type disabled if using hosted UI. Can be enabled after creation.
    //client_credentials also to require `generateSecret` which complicate admin login.
    //allowedOauthFlows: ["code", "client_credentials"],
    callbackUrls: [callbackUrl],
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
