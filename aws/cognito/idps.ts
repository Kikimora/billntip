import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import userPool from "./userpool";
import * as config from "../config";

// Note - providerName and providerType must match - https://github.com/aws/aws-cli/issues/3179
export const facebookIdp = new aws.cognito.IdentityProvider("cognito-facebook-idp", {
    //providerName MUST be the same as providerType
    providerName: 'Facebook',
    providerType: "Facebook",
    userPoolId: userPool.id,
    providerDetails: {
        client_id: config.facebookClientId,
        client_secret: config.facebookClientSecret,
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

export const googleIdp = new aws.cognito.IdentityProvider("cognito-google-idp", {
    //providerName MUST be the same as providerType
    providerName: 'Google',
    providerType: "Google",
    userPoolId: userPool.id,
    providerDetails: {
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
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

export const appleIdp = new aws.cognito.IdentityProvider("cognito-apple-idp", {
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
            client_id: config.appleClientId,
            team_id: config.appleTeamId,
            key_id: config.appleKeyId,
            private_key: config.applePrivateKey,
            attributes_url_add_attributes: "false",
            authorize_url: "https://appleid.apple.com/auth/authorize",
            oidc_issuer: "https://appleid.apple.com",
            token_request_method: "POST",
            token_url: "https://appleid.apple.com/auth/token"
        },
        idpIdentifiers: [],
    },
    //Ignore changes in providerDetails otherwise Pulumi detects changes every update.
    {ignoreChanges: ['providerDetails']});
