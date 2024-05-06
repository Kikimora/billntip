import {
    CustomMessageTriggerEvent,
    PostAuthenticationTriggerEvent,
    PostConfirmationConfirmSignUpTriggerEvent,
    PreSignUpTriggerEvent, PreTokenGenerationTriggerEvent
} from 'aws-lambda';
import {CognitoIdentityProvider, UserType} from "@aws-sdk/client-cognito-identity-provider";
import _ from "lodash";
import {BaseTriggerEvent} from "aws-lambda/trigger/cognito-user-pool-trigger/_common";
import {generate} from "generate-password";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {configure, errorWithContext, Tracer} from "@app/diagnostics";
import {pipeline, TracedEvent} from "@app/lambda";
import UserRepo, {UserAttribute} from './user';
import {toUserAttributes} from "./cognito";

configure({
    triggers: {
        request: true
    }
})

const cognito = new CognitoIdentityProvider()
const dynamodb = new DynamoDB()
const tracer = new Tracer("cognito")

function eventTriggerSource(event: BaseTriggerEvent<string>) {
    return event.triggerSource.split('_')[0]
}

function isPreSignUpTriggerEvent(event: BaseTriggerEvent<string>): event is PreSignUpTriggerEvent {
    return event.triggerSource.startsWith("PreSignUp")
}

function isPostConfirmationConfirmSignUpTriggerEvent(event: BaseTriggerEvent<string>): event is PostConfirmationConfirmSignUpTriggerEvent {
    return event.triggerSource.startsWith("PostConfirmation")
}

function isPostAuthenticationTriggerEvent(event: BaseTriggerEvent<string>): event is PostAuthenticationTriggerEvent {
    return event.triggerSource.startsWith("PostAuthentication")
}

function isPreTokenGenerationTriggerEvent(event: BaseTriggerEvent<string>): event is PreTokenGenerationTriggerEvent {
    return event.triggerSource.startsWith("TokenGeneration")
}

function isCustomMessageTriggerEvent(event: BaseTriggerEvent<string>): event is CustomMessageTriggerEvent {
    return event.triggerSource.startsWith("CustomMessage")
}

export const trigger = async function (event: BaseTriggerEvent<any> & TracedEvent, context: any) {
    if (isPreSignUpTriggerEvent(event)) {
        switch (event.triggerSource) {
            /**
             * [Pre signup]{@link https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-sign-up.html} trigger event.
             */
            case "PreSignUp_ExternalProvider": {
                //Important note: this function calls adminCreateUser which triggers this handler again with
                //triggerSource === 'PreSignUp_AdminCreateUser'
                await linkSocialProfile(event)
                break
            }
            case "PreSignUp_AdminCreateUser":
            /**
             * Response parameters autoVerifyPhone, autoVerifyEmail and autoConfirmUser are ignored by Amazon Cognito
             * when the pre sign-up Lambda function is triggered by the AdminCreateUser API.
             */
            case "PreSignUp_SignUp": {
                const attributeSource = event.triggerSource === 'PreSignUp_AdminCreateUser' ? 'trusted' : 'user'
                const {userName} = event
                const repo = new UserRepo({
                    db: dynamodb,
                    tag: context.awsRequestId
                })
                //"POST /user" puts attributes into the client metadata
                const normalAttributes: UserAttribute[] = JSON.parse(event.request.clientMetadata?.['_attributes'] ?? "[]")
                const aliases = _.map(event.request.userAttributes, (Value, Name) => ({Name, Value}));
                const aliasAttributes = toUserAttributes(aliases)
                try {
                    await repo.create(userName, attributeSource, normalAttributes.concat(aliasAttributes))
                } catch (e) {
                    throw errorWithContext(e, 'trigger', {
                        attributeSource,
                        normalAttributes,
                        aliasAttributes,
                        userName
                    })
                }
                break
            }
        }
    } else if (isPostConfirmationConfirmSignUpTriggerEvent(event)) {
        /**
         * Handle [post confirmation]{@link https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-post-confirmation.html} event.
         * @param event post confirmation event.
         */
        switch (event.triggerSource) {
            case 'PostConfirmation_ConfirmForgotPassword':
            case 'PostConfirmation_ConfirmSignUp':
        }
    } else if (isPostAuthenticationTriggerEvent(event)) {
        /**
         * Handle [post authentication]{@link https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-post-authentication.html} event.
         * @param event post authentication event.
         */
        switch (event.triggerSource) {
            case 'PostAuthentication_Authentication':
        }
    } else if (isPreTokenGenerationTriggerEvent(event)) {
        /**
         * Handle [pre token generation]{@link https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html} event.
         * @param event pre token generation event.
         */
        switch (event.triggerSource) {
            case 'TokenGeneration_AuthenticateDevice':
            case 'TokenGeneration_Authentication':
            case 'TokenGeneration_HostedAuth':
            case 'TokenGeneration_NewPasswordChallenge':
            case 'TokenGeneration_RefreshTokens':
        }
    } else if (isCustomMessageTriggerEvent(event)) {
        /**
         * Handle [custom message]{@link https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-custom-message.html} event.
         * @param event post authentication event.
         */
        switch (event.triggerSource) {
            case 'CustomMessage_AdminCreateUser':
            case 'CustomMessage_Authentication':
            case 'CustomMessage_ForgotPassword':
            case 'CustomMessage_ResendCode':
            case 'CustomMessage_SignUp':
            case 'CustomMessage_UpdateUserAttribute':
            case 'CustomMessage_VerifyUserAttribute':
        }
    }
    return event
};
export const handler = pipeline<BaseTriggerEvent<any>>()
    .traceRequest({
        tracer,
        tag: eventTriggerSource
    })
    .done(trigger)


async function linkSocialProfile(event: PreSignUpTriggerEvent & TracedEvent) {
    const {
        userPoolId,
        userName,
        request: {userAttributes: {email, ...attrs}},
    } = event;

    // --> User has registered with Google/Facebook external providers
    async function fetchCognitoUser(email: string) {
        try {
            const {Users: users} = await cognito.listUsers({
                UserPoolId: userPoolId,
                AttributesToGet: ['email'],
                Filter: `email = "${email}"`,
                Limit: 1
            })
            return users?.[0]
        } catch (e) {
            throw errorWithContext(e, 'fetchCognitoUser', {email})
        }
    }

    event.tracer.info("fetchCognitoUser", {email})
    let cognitoUser = await fetchCognitoUser(email)
    if (cognitoUser === undefined) {
        event.tracer.info("Cognito user not found", {email})

        /* --> user does not have a cognito native account ->
             1. create a native cognito account
             2. change the password, to change status from FORCE_CHANGE_PASSWORD to CONFIRMED
         */
        async function createCognitoUser(email: string, attrs: Record<string, string>) {
            function* attributes() {
                yield {Name: 'email', Value: email}
                yield {Name: 'email_verified', Value: 'true'}
                if (attrs !== undefined) {
                    for (const key of _.keys(attrs)) {
                        yield {Name: key, Value: attrs[key]}
                    }
                }
            }

            const args = {
                UserPoolId: userPoolId,
                // SUPRESS prevents sending an email with the temporary password
                // to the user on account creation
                MessageAction: 'SUPPRESS',
                Username: email,
                UserAttributes: Array.from(attributes()),
            } as const;
            try {
                const {User: user} = await cognito.adminCreateUser(args)
                return user
            } catch (e) {
                throw errorWithContext(e, 'createCognitoUser', {args})
            }
        }

        event.tracer.info("Create Cognito user", {email, attrs})
        cognitoUser = await createCognitoUser(email, attrs)
        if (cognitoUser === undefined) throw new Error("Unexpected error: cognito didn't create user.")
        event.tracer.info("Created cognito user", {cognitoUser})

        async function describeUserPool(userPoolId: string) {
            try {
                const {UserPool: userPool} = await cognito.describeUserPool({UserPoolId: userPoolId})
                return userPool
            } catch (e) {
                throw errorWithContext(e, 'createCognitoUser', {userPoolId})
            }
        }

        event.tracer.info("Fetch user pool parameters", {userPoolId})
        const userPool = await describeUserPool(userPoolId)
        if (userPool === undefined) throw new Error("Unexpected error: cognito didn't return user pool details.")

        const passwordPolicy = userPool.Policies?.PasswordPolicy
        event.tracer.info('Generate password with user pool password policy', {passwordPolicy})
        if (passwordPolicy === undefined) throw new Error("Unexpected error: cognito user pool does not have a password policy.")
        const password = generate({
            length: passwordPolicy.MinimumLength ?? 6,
            uppercase: passwordPolicy.RequireUppercase,
            lowercase: passwordPolicy.RequireLowercase,
            numbers: passwordPolicy.RequireNumbers,
            symbols: passwordPolicy.RequireSymbols,
        })

        async function adminSetUserPassword(cognitoUser: UserType, password: string) {
            try {
                await cognito.adminSetUserPassword({
                    Password: password,
                    UserPoolId: userPoolId,
                    Username: cognitoUser.Username,
                    Permanent: true,
                })
            } catch (e) {
                throw errorWithContext(e, 'adminSetUserPassword', {})
            }
        }

        event.tracer.info('Set user password', {cognitoUser})
        await adminSetUserPassword(cognitoUser, password)

        event.response.autoVerifyEmail = true;
        event.response.autoConfirmUser = true;
    }

    // userName example: "Facebook_12324325436" or "Google_1237823478"
    const [providerNameValue, providerUserId] = userName.split('_');
    // Uppercase the first letter because the event sometimes
    // has it as google_1234 or facebook_1234. In the call to `adminLinkProviderForUser`
    // the provider name has to be Google or Facebook (first letter capitalized)
    const providerName = _.capitalize(providerNameValue);

    async function adminLinkProviderForUser(cognitoUser: UserType) {
        const args = {
            DestinationUser: {
                ProviderAttributeValue: cognitoUser.Username,
                ProviderName: 'Cognito',
            },
            SourceUser: {
                ProviderAttributeName: 'Cognito_Subject',
                ProviderAttributeValue: providerUserId,
                ProviderName: providerName,
            },
            UserPoolId: userPoolId,
        } as const;
        try {
            await cognito.adminLinkProviderForUser(args)
        } catch (e) {
            throw errorWithContext(e, 'adminLinkProviderForUser', {args})
        }
    }

    event.tracer.info('Link cognito user with the social profile', {cognitoUser, providerUserId, providerName})
    await adminLinkProviderForUser(cognitoUser)
}