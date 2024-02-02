import {PreSignUpTriggerEvent} from 'aws-lambda';
import {linkSocialProfile} from "./cognito";

// noinspection JSUnusedGlobalSymbols
export async function preSignup(event: PreSignUpTriggerEvent) {
    const {triggerSource} = event;
    if (triggerSource == "PreSignUp_ExternalProvider") {
        await linkSocialProfile(event);
    }

    return event
}

