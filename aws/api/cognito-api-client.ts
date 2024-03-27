import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import cognito from "@aws/cognito";
import gateway from "./gateway"

const tokenValidity = {
    accessTokenValidity: 3600,
    refreshTokenValidity: 365,
    idTokenValidity: 3600,
    tokenValidityUnits: {
        idToken: "seconds",
        accessToken: "seconds",
        refreshToken: "days"
    }
}

const cognitoApiClient = new aws.cognito.UserPoolClient("cognito-api-client", {
    userPoolId: cognito.userPool.id,
    allowedOauthFlows: ["code"],
    allowedOauthScopes: ["phone", "email", "openid", "profile", "aws.cognito.signin.user.admin"],
    //Notes:
    //If generateSecret is true then AdminInitiateLogin wants SECRET_HASH
    generateSecret: true,
    //Client credentials grant type disabled if using hosted UI. Can be enabled after creation.
    //client_credentials also to require `generateSecret` which complicate admin login.
    //allowedOauthFlows: ["code", "client_credentials"],
    callbackUrls: [gateway.authCallback],
    allowedOauthFlowsUserPoolClient: true,
    explicitAuthFlows: ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"],
    ...tokenValidity,
    supportedIdentityProviders: [
        "COGNITO",
        cognito.identityProviders.google.name,
        cognito.identityProviders.facebook.name,
        cognito.identityProviders.apple.name
    ],
    writeAttributes: []
}, {ignoreChanges: ['callbackUrls']});

type TokenType = "accessToken" | "idToken" | 'refreshToken'

export default {
    id: cognitoApiClient.id,
    urn: cognitoApiClient.urn,
    tokenValidityInSeconds(token: TokenType) {
        const tokenUnits = tokenValidity.tokenValidityUnits[token] ?? 'hours'
        const tokenValue = (tokenValidity as any)[`${token}Validity`] as number
        switch (tokenUnits) {
            case 'seconds':
                return tokenValue
            case 'minutes':
                return tokenValue * 60
            case 'hours':
                return tokenValue * 3600
            case 'days':
                return tokenValue * 3600 * 24
            default:
                throw new Error('Unexpected token units ' + tokenUnits)
        }
    }
}