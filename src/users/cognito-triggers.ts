import {
    CustomMessageTriggerEvent,
    PostAuthenticationTriggerEvent,
    PostConfirmationConfirmSignUpTriggerEvent,
    PreSignUpTriggerEvent,
    PreTokenGenerationTriggerEvent
} from 'aws-lambda';
import {CognitoIdentityProvider, UserType} from "@aws-sdk/client-cognito-identity-provider";
import _ from "lodash";
import {BaseTriggerEvent} from "aws-lambda/trigger/cognito-user-pool-trigger/_common";
import {Type} from "@sinclair/typebox";
import diagnostics, {errorWithContext, Tracer, TracingOptions} from "@app/diagnostics";
import {moduleConfig, pipeline, TracedEvent} from "@app/lambda";
import {TemplateRepo} from "../templates";
import {UserAttribute} from "./attributes";
import {generatePassword} from "@src/users/cognito";

const cognito = new CognitoIdentityProvider()
const tracer = new Tracer("cognito")
const config = moduleConfig()
    .parameters({
        s3: Type.Object({bucket: Type.String()}),
        'cognito-triggers': Type.Object({}, {relaxed: true, default: {triggers: {request: true}}}),
    })
    .build()

// noinspection JSUnusedGlobalSymbols
export async function __init() {
    return config.parameters.then(function ({s3, 'cognito-triggers': diag}) {
        const templates = new TemplateRepo({
            bucket: s3.bucket,
            cache: process.env.ENV === 'prod'
        })
        diagnostics(diag as TracingOptions)
        return {templates}
    })
}

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

export const trigger = async function (event: BaseTriggerEvent<any> & TracedEvent) {
    const {templates} = await __init()

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
        const {request, response} = event
        const {_attributes, password, ...metadata} = event.request.clientMetadata ?? {}

        const attributes = {
            ..._(JSON.parse(_attributes ?? '[]') as UserAttribute[])
                .keyBy('name')
                .mapValues('value')
                .value(),
            ...request.userAttributes,
            password
        }

        function targetAttribute() {
            const userAttributes = request.userAttributes;
            if ('email' in userAttributes && !('email_verified' in userAttributes)) {
                return 'email'
            } else if ('phone_number' in userAttributes && !('phone_number_verified' in userAttributes)) {
                return 'phone_number'
            } else {
                return undefined
            }
        }

        //Problem: [AWS Cognito - Custom email message with Lambda trigger being overwritten](https://stackoverflow.com/questions/61514305/aws-cognito-custom-email-message-with-lambda-trigger-being-overwritten)
        //>
        //> For anyone finding this, I was able to find the answer. When using the CustomMessage_AdminCreateUser
        //> event, cognito will silently throw an error if you use event.userName in the template. Instead,
        //> use event.request.usernameParameter and it will work
        let context = {
            metadata: {
                ...metadata,
                env: process.env.ENV ?? "dev"
            },
            attributes,
            username: request.usernameParameter ?? '',
            code: request.codeParameter,
            link: request.linkParameter,
            type: _.kebabCase(event.triggerSource.substring(14/*"CustomMessage_".length*/)),
            attribute: targetAttribute(),
            password
        }
        const messageTemplate = await templates.fetchTemplate(context.type + "-email.html")
        response.emailMessage = messageTemplate.body(context)

        switch (event.triggerSource) {
            case 'CustomMessage_AdminCreateUser':
            case 'CustomMessage_SignUp':
                response.emailSubject = "Welcome to Bill&Tip"
                break
            case 'CustomMessage_Authentication':
                response.emailSubject = "Welcome to Bill&Tip"
                break
            case 'CustomMessage_ForgotPassword':
                response.emailSubject = "Welcome to Bill&Tip"
                break
            case 'CustomMessage_ResendCode':
                response.emailSubject = "Welcome to Bill&Tip"
                switch (context.attribute) {
                    case 'email':
                        response.emailSubject = "Bill&Tip: Resend Verification Code for Email"
                        break
                    case 'phone_number':
                        response.smsMessage = `Hello, please use the following code to verify your phone number: ${request.codeParameter}`
                        break;
                    default:
                        response.emailSubject = `Verify your attribute`
                        response.smsMessage = `Hello, please use the following code to verify your phone number: ${request.codeParameter}`
                }
                break
            case 'CustomMessage_UpdateUserAttribute':
                switch (context.attribute) {
                    case 'email':
                        response.emailSubject = "Bill&Tip: please verify your email"
                        break
                    case 'phone_number':
                        response.smsMessage = `Hello, please use the following code to verify your phone number: ${request.codeParameter}`
                        break;
                    default:
                        response.emailSubject = `Verify your attribute`
                        response.smsMessage = `Hello, please use the following code to verify your phone number: ${request.codeParameter}`
                }
                break
            case 'CustomMessage_VerifyUserAttribute':
                response.emailSubject = "Bill&Tip: please verify your email."
                response.smsMessage = `Hello, please use the following code to verify your phone number: ${request.codeParameter}`
                break
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
        const password = await generatePassword(userPoolId);

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