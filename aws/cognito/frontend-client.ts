import * as aws from "@pulumi/aws";
import {userPool} from "./userpool";
import {callbackUrl} from "./settings";
import {appleIdp, facebookIdp, googleIdp} from "./idps";

export const frontendClient = new aws.cognito.UserPoolClient("cognito-frontend-client", {
    userPoolId: userPool.id,
    allowedOauthFlows: ["code"],
    allowedOauthScopes: ["phone", "email", "openid", "profile", "aws.cognito.signin.user.admin"],
    generateSecret: false,
    //Client credentials grant type disabled if using hosted UI. Can be enabled after creation.
    //Also client_credentials seem to require `generateSecret` which complicate admin login.
    //allowedOauthFlows: ["code", "client_credentials"],
    callbackUrls: [callbackUrl],
    allowedOauthFlowsUserPoolClient: true,
    explicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"],
    //Frontend client can only use short-lived tokens.
    accessTokenValidity: 3600,
    refreshTokenValidity: 3600,
    idTokenValidity: 3600,
    tokenValidityUnits: {
        idToken: "seconds",
        accessToken: "seconds",
        refreshToken: "seconds"
    },
    supportedIdentityProviders: [
        "COGNITO",
        googleIdp.providerName,
        facebookIdp.providerName,
        appleIdp.providerName
    ],

}, {ignoreChanges: ['callbackUrls']});
