import * as aws from "@pulumi/aws";
import cognito from "@aws/cognito";
import gateway from "@aws/api/gateway";

const cognitoFrontendClient = new aws.cognito.UserPoolClient("cognito-frontend-client", {
    userPoolId: cognito.userPool.id,
    allowedOauthFlows: ["code"],
    allowedOauthScopes: ["phone", "email", "openid", "profile", "aws.cognito.signin.user.admin"],
    generateSecret: false,
    //Client credentials grant type disabled if using hosted UI. Can be enabled after creation.
    //Also client_credentials seem to require `generateSecret` which complicate admin login.
    //allowedOauthFlows: ["code", "client_credentials"],
    callbackUrls: [gateway.authCallback],
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
        cognito.identityProviders.google.name,
        cognito.identityProviders.facebook.name,
        cognito.identityProviders.apple.name
    ],
    writeAttributes: []
}, {ignoreChanges: ['callbackUrls']});

export default {
    id: cognitoFrontendClient.id,
    urn: cognitoFrontendClient.urn,
}