import {RouteMap} from "@app/lambda";
import * as schemas from './schemas';
import {authenticatedEndpoint, publicEndpoint} from "@src/common";
import {Upload} from "@src/object-store";


export default {
    "POST /user": {
        operationId: "POST /user",
        body: schemas.SignUpBody,
        success: schemas.SignUpResponse,
        responses: [400],
        security: publicEndpoint,
        tags: ['SignUp']
    },
    "POST /user/confirm": {
        operationId: "POST /user/confirm",
        body: schemas.ConfirmSignUpBody,
        responses: [400],
        success: schemas.ConfirmSignUpResponse,
        security: publicEndpoint,
        tags: ['SignUp']
    },
    "POST /user/resend_confirmation_code": {
        operationId: "POST /user/resend_confirmation_code",
        body: schemas.ResendConfirmationCodeBody,
        success: schemas.ResendConfirmationCodeResponse,
        responses: [400],
        security: publicEndpoint,
        tags: ['SignUp']
    },

    "POST /user/signin": {
        operationId: "POST /user/signin",
        body: schemas.InitiateAuthBody,
        success: schemas.AuthResponse,
        responses: [400],
        security: publicEndpoint,
        tags: ['Session']
    },
    "POST /user/signin/challenge": {
        operationId: "POST /user/signin/challenge",
        body: schemas.RespondToAuthChallengeBody,
        success: schemas.AuthResponse,
        responses: [400],
        security: publicEndpoint,
        tags: ['Session']
    },
    "GET /user/session": {
        operationId: "GET /user/session",
        success: schemas.GetSessionResponse,
        responses: [401, 403],
        security: authenticatedEndpoint,
        tags: ['Session']
    },
    "POST /user/session": {
        operationId: "POST /user/session",
        success: schemas.GetSessionResponse,
        responses: [401, 403],
        security: authenticatedEndpoint,
        tags: ['Session']
    },
    "DELETE /user/session": {
        operationId: "DELETE /user/session",
        security: authenticatedEndpoint,
        responses: [401, 403],
        tags: ['Session']
    },

    "GET /user/attributes": {
        operationId: "GET /user/attributes",
        success: schemas.UserAttributes,
        responses: [401, 403],
        security: authenticatedEndpoint,
        tags: ['Attributes']
    },
    "PUT /user/attributes": {
        operationId: "PUT /user/attributes",
        body: schemas.UpdateUserAttributesBody,
        success: schemas.UpdateUserAttributesResponse,
        responses: [400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Attributes']
    },
    "POST /user/image": {
        operationId: "POST /user/image",
        success: Upload,
        responses: [400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Attributes']
    },
    "DELETE /user/attributes": {
        operationId: "DELETE /user/attributes",
        body: schemas.DeleteUserAttributesBody,
        success: schemas.DeleteUserAttributesResponse,
        responses: [400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Attributes']
    },

    "POST /user/password": {
        operationId: "POST /user/password",
        body: schemas.ChangePasswordBody,
        success: schemas.ChangePasswordResponse,
        responses: [400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Password']
    },
    "POST /user/password/forgot": {
        operationId: "POST /user/password/forgot",
        body: schemas.ForgotPasswordBody,
        success: schemas.ForgotPasswordResponse,
        responses: [400],
        security: publicEndpoint,
        tags: ['Password']
    },
    "POST /user/password/confirm": {
        operationId: "POST /user/password/confirm",
        body: schemas.ConfirmForgotPasswordBody,
        success: schemas.ConfirmForgotPasswordResponse,
        responses: [400],
        security: publicEndpoint,
        tags: ['Password']
    },

    "GET /user/devices": {
        operationId: "GET /user/devices",
        body: schemas.GetDevicesBody,
        success: schemas.GetDevicesResponse,
        responses: [400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Devices']
    },
    "GET /user/device/{id}": {
        operationId: "GET /user/device/{id}",
        path: {id: schemas.DeviceId},
        success: schemas.GetDeviceBody,
        responses: [400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Devices']
    },
    "PUT /user/device/{id}": {
        operationId: "PUT /user/device/{id}",
        path: {id: schemas.DeviceId},
        body: schemas.UpdateDeviceStatusBody,
        success: schemas.UpdateDeviceStatusResponse,
        responses: [400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Devices']
    },
    "PUT /user/device/{id}/confirm": {
        operationId: "PUT /user/device/{id}/confirm",
        path: {id: schemas.DeviceId},
        body: schemas.ConfirmDeviceBody,
        success: schemas.ConfirmDeviceResponse,
        responses: [400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Devices']
    },
    "DELETE /user/device/{id}": {
        operationId: "DELETE /user/device/{id}",
        path: {id: schemas.DeviceId},
        success: schemas.ForgetDeviceResponse,
        responses: [400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Devices']
    },
} as const satisfies RouteMap