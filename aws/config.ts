import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
export const domain = config.require('domain')
export const regionalCertificate = config.require('cert-regional')
export const useast1Certificate = config.require('cert-us-east-1')
export const smsExternalId = config.require('cognito-sms-external-id')
export const facebookClientId = config.require('facebook_client_id')
export const facebookClientSecret = config.requireSecret('facebook_client_secret')
export const googleClientId = config.require('google_client_id')
export const googleClientSecret = config.requireSecret('google_client_secret')
export const appleClientId = config.require('apple_client_id')
export const appleTeamId = config.require('apple_team_id')
export const appleKeyId = config.require('apple_key_id')
export const applePrivateKey = config.requireSecret('apple_private_key')

export const stack = pulumi.getStack()

const awsConfig = new pulumi.Config("aws");
export const region = awsConfig.require('region')
export const profile = awsConfig.require('profile')
export const configFolder = `/${pulumi.getOrganization()}/${pulumi.getProject()}/${pulumi.getStack()}`

export const tags = {
    'env': stack,
    'project': 'Bill And Tip'
}

