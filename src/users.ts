import {
    BasePreTokenGenerationV2TriggerEvent, PostAuthenticationTriggerEvent,
    PostConfirmationConfirmSignUpTriggerEvent,
    PreSignUpTriggerEvent
} from 'aws-lambda';
import {adminUpdateAttributes, linkSocialProfile} from "./cognito";
import {configure, Tracer} from "@app/diagnostics";
import {pipeline} from "@app/lambda";

configure({
    triggers: {
        request: true
    }
})

const tracer = new Tracer("cognito")

export const preSignup = pipeline<PreSignUpTriggerEvent>()
    .traceRequest({tracer, tag: "preSignup"})
    .done(async function (event: PreSignUpTriggerEvent) {
        const {triggerSource} = event;
        switch (triggerSource) {
            case "PreSignUp_ExternalProvider": {
                await linkSocialProfile(event);
                break
            }
            case "PreSignUp_AdminCreateUser": {
                // https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-sign-up.html
                // Response parameters autoVerifyPhone, autoVerifyEmail and autoConfirmUser are ignored by Amazon Cognito
                // when the pre sign-up Lambda function is triggered by the AdminCreateUser API.
                break
            }
        }
        return event
    })

/**
 * Handle [post confirmation]{@link https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-post-confirmation.html} event.
 * @param event post confirmation event.
 */
export const postSignup = pipeline<PostConfirmationConfirmSignUpTriggerEvent>()
    .traceRequest({tracer, tag: "postSignup"})
    .done(async function (event: PostConfirmationConfirmSignUpTriggerEvent) {
        await adminUpdateAttributes(event.userPoolId, event.userName, {
            "email_verified": "true"
        })
        return event
    })

export const info = pipeline<any>()
    .traceRequest({tracer, tag: "info"})
    .done(async function (event) {
        return event
    })