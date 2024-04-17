import {
    PostAuthenticationTriggerEvent,
    PostConfirmationConfirmSignUpTriggerEvent,
    PreSignUpTriggerEvent, PreTokenGenerationTriggerEvent
} from 'aws-lambda';
import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {adminUpdateAttributes, linkSocialProfile} from "./cognito";
import {configure, Tracer} from "@app/diagnostics";
import {pipeline} from "@app/lambda";
import _ from "lodash";
import * as process from "process";

configure({
    triggers: {
        request: true
    }
})

let COUNTRY_BLACKLIST = process.env.COUNTRY_BLACKLIST?.split(',').map(x => x.toLowerCase().trim()) ?? []

const cognito = new CognitoIdentityProvider()

const tracer = new Tracer("cognito")

/**
 * Set country blacklist.
 */
export function setCountryBlacklist(blacklist: string[]) {
    COUNTRY_BLACKLIST = blacklist
}

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
        const {'custom:uid': uid, sub} = event.request.userAttributes
        const attributes = {
            'custom:uid': uid ?? sub
        };
        await adminUpdateAttributes(event.userPoolId, event.userName, attributes)
        return event
    })

export const info = pipeline<any>()
    .traceRequest({tracer, tag: "info"})
    .done(async function (event) {
        return event
    })

/**
 * This trigger verifies user's email or phone after successful login. It depends on the userpool `username attributes`
 * configuration to be `email | phone`. Post authentication trigger invoked in two cases
 * 1. Normal user login, happens after user verified contact method defined by the username attribute (email or phone).
 * 2. Login after invite - in this case password delivered to a contact method defined by the username attribute
 * (email or phone). Successful login means user has access to the contact method.
 */
export const postAuthentication = pipeline<PostAuthenticationTriggerEvent>()
    .traceRequest({tracer, tag: "postAuthentication"})
    .done(async function (event) {
        const {userName, userPoolId, request: {userAttributes}, triggerSource} = event
        const {email_verified, phone_verified} = userAttributes

        switch (triggerSource) {
            case "PostAuthentication_Authentication":
                const isPhone = userName.startsWith("+");
                const isEmail = userName.indexOf("@")
                let attribute
                if (isPhone && phone_verified != "true") {
                    attribute = "phone_number_verified"
                } else if (isEmail && email_verified != "true") {
                    attribute = "email_verified"
                }
                if (attribute !== undefined) {
                    event.tracer.info("Verify username attribute")
                    await cognito.adminUpdateUserAttributes({
                        UserPoolId: userPoolId,
                        Username: userName,
                        UserAttributes: [{
                            Name: attribute,
                            Value: "true"
                        }]
                    })
                }

                break;
        }
        return event
    })

/**
 * This trigger add user into 'recipients' group if user provided address and other required details.
 */
export const preTokenGeneration = pipeline<PreTokenGenerationTriggerEvent>()
    .traceRequest({tracer, tag: "preTokenGeneration"})
    .done(async function (event) {
        const {
            userName,
            userPoolId,
            request: {
                userAttributes,
                groupConfiguration: {groupsToOverride: groups}
            }
        } = event
        const {address: addressJson, given_name, family_name} = userAttributes

        if ((groups?.indexOf("recipients") ?? -1) >= 0) {
            tracer.info("User already in the 'recipients' group")
            return event
        }
        if (_.isEmpty(addressJson) || _.isEmpty(given_name) || _.isEmpty(family_name)) {
            tracer.info("Cannot add to 'recipients', one of the required attributes is missing")
            return event;
        }
        try {
            //https://openid.net/specs/openid-connect-core-1_0.html#AddressClaim
            const {country, postal_code, street_address} = JSON.parse(addressJson)
            if (_.isEmpty(country) || _.isEmpty(postal_code) || _.isEmpty(street_address)) {
                tracer.info("Cannot add to 'recipients', invalid address")
                return event;
            }
            if (COUNTRY_BLACKLIST.indexOf(country.toLowerCase()) >= 0) {
                tracer.info("Cannot add to 'recipients', address is from a blacklisted country")
                return event;
            }
        } catch (e) {
            tracer.warn("Cannot add to 'recipients', address is not a valid JSON.", {address: addressJson})
            return event
        }
        await cognito.adminAddUserToGroup({
            UserPoolId: userPoolId,
            Username: userName,
            GroupName: "recipients"
        })
        return event
    })