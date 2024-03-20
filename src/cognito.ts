import {
    AdminAddUserToGroupCommand,
    AdminCreateUserCommand,
    AdminLinkProviderForUserCommand,
    AdminSetUserPasswordCommand, AdminUpdateUserAttributesCommand,
    CognitoIdentityProviderClient, DescribeUserPoolClientCommand,
    DescribeUserPoolCommand,
    ListUsersCommand
} from "@aws-sdk/client-cognito-identity-provider";
import _ from "lodash";
import {generate} from "generate-password";
import {LRUCache} from "lru-cache";
import {PreSignUpTriggerEvent} from "aws-lambda";

const cognito = new CognitoIdentityProviderClient()

export async function findUserByEmail(userPoolId: string, email: string) {
    const command = new ListUsersCommand({
        UserPoolId: userPoolId,
        AttributesToGet: ['email'],
        Filter: `email = "${email}"`,
        Limit: 1
    });
    const result = await cognito.send(command);
    return result.Users?.[0]
}

export async function adminLinkUserAccounts(userPoolId: string, username: string, providerName: string, providerUserId: string) {
    const command = new AdminLinkProviderForUserCommand({
        DestinationUser: {
            ProviderAttributeValue: username,
            ProviderName: 'Cognito',
        },
        SourceUser: {
            ProviderAttributeName: 'Cognito_Subject',
            ProviderAttributeValue: providerUserId,
            ProviderName: providerName,
        },
        UserPoolId: userPoolId,
    })
    await cognito.send(command)
}

export async function adminCreateUser(userPoolId: string, email: string, attrs?: { [name: string]: string }) {

    function* attributes() {
        yield {Name: 'email', Value: email}
        yield {Name: 'email_verified', Value: 'true'}
        if (attrs !== undefined) {
            for (const key of _.keys(attrs)) {
                yield {Name: key, Value: attrs[key]}
            }
        }
    }

    const command = new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        // SUPRESS prevents sending an email with the temporary password
        // to the user on account creation
        MessageAction: 'SUPPRESS',
        Username: email,
        UserAttributes: Array.from(attributes()),
    });

    const result = await cognito.send(command)
    return result.User!
}

export async function adminSetUserPassword(userPoolId: string, username: string, password?: string) {

    if (password === undefined) {
        const userPool = await getOrFetchUserPoolById(userPoolId)
        const passwordPolicy = userPool.Policies?.PasswordPolicy!
        password = generate({
            length: passwordPolicy.MinimumLength ?? 6,
            uppercase: passwordPolicy.RequireUppercase,
            lowercase: passwordPolicy.RequireLowercase,
            numbers: passwordPolicy.RequireNumbers,
            symbols: passwordPolicy.RequireSymbols,
        })
    }

    const command = new AdminSetUserPasswordCommand({
        Password: password,
        UserPoolId: userPoolId,
        Username: username,
        Permanent: true,
    });
    await cognito.send(command)
}

export async function adminAddUserToGroup(userPoolId: string, username: string, groupName: string) {
    const command = new AdminAddUserToGroupCommand({
        GroupName: groupName,
        UserPoolId: userPoolId,
        Username: username,
    });
    await cognito.send(command)
}

export async function adminUpdateAttributes(userPoolId: string, username: string, attributes: Record<string, string>) {
    const command = new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: username,
        UserAttributes: Object.entries(attributes).map(([k, v]) => ({
            Name: k, Value: v
        }))
    });
    return await cognito.send(command)
}

export async function describeUserPool(userPoolId: string) {
    const command = new DescribeUserPoolCommand({UserPoolId: userPoolId})
    const r = await cognito.send(command)
    if (_.isNull(r?.UserPool)) throw new Error(`UserPool ${userPoolId} not found`)
    return r.UserPool!
}

export async function describeUserPoolClient(userPoolId: string, clientId: string) {
    const command = new DescribeUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientId: clientId
    })
    const r = await cognito.send(command)
    if (_.isNull(r?.UserPoolClient)) throw new Error(`UserPoolClient ${clientId} not found`)
    return r.UserPoolClient!
}

export const getOrFetchUserPoolById = _.memoize(describeUserPool)
getOrFetchUserPoolById.cache = new LRUCache({max: 10, ttl: 1000 * 60 * 5})

type SocialProfileLink = { username: string, providerName: string, providerUserId: string }

export async function linkSocialProfile(event: PreSignUpTriggerEvent): Promise<SocialProfileLink> {
    if (event.triggerSource !== "PreSignUp_ExternalProvider")
        throw new Error("Cannot link user profile.");

    const {
        userPoolId,
        userName,
        request: {userAttributes: {email, ...attrs}},
    } = event;
    // --> User has registered with Google/Facebook external providers
    let cognitoUser = await findUserByEmail(userPoolId, email);
    if (cognitoUser === undefined) {
        /* --> user does not have a cognito native account ->
           1. create a native cognito account
           2. change the password, to change status from FORCE_CHANGE_PASSWORD to CONFIRMED
       */
        cognitoUser = await adminCreateUser(userPoolId, email, attrs)
        await adminSetUserPassword(userPoolId, email);
        event.response.autoVerifyEmail = true;
        event.response.autoConfirmUser = true;
    }

    // userName example: "Facebook_12324325436" or "Google_1237823478"
    const [providerNameValue, providerUserId] = userName.split('_');
    // Uppercase the first letter because the event sometimes
    // has it as google_1234 or facebook_1234. In the call to `adminLinkProviderForUser`
    // the provider name has to be Google or Facebook (first letter capitalized)
    const providerName = _.capitalize(providerNameValue);
    if (cognitoUser.Username === undefined) throw new Error(`Cognito user does not have a username`)
    const username = cognitoUser.Username;
    await adminLinkUserAccounts(userPoolId, username, providerName, providerUserId);
    return {username, providerName, providerUserId}
}
