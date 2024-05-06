import {RouteMap} from "@app/lambda";
import * as schemas from './schemas';
import {authenticatedEndpoint, publicEndpoint} from "@src/common";


export default {
    "POST /user": {
        operationId: "SignUp",
        body: schemas.SignUpBody,
        success: schemas.SignUpResponse,
        responses: [400],
        security: publicEndpoint,
        tags: ['SignUp']
    },
    "POST /user/confirm": {
        operationId: "ConfirmSignUp",
        body: schemas.ConfirmSignUpBody,
        responses: [{200: schemas.ConfirmSignUpResponse}, 400],
        security: publicEndpoint,
        tags: ['SignUp']
    },
    "POST /user/resend_confirmation_code": {
        operationId: "ResendConfirmationCode",
        body: schemas.ResendConfirmationCodeBody,
        responses: [{200: schemas.ResendConfirmationCodeResponse}, 400],
        security: publicEndpoint,
        tags: ['SignUp']
    },

    "POST /user/signin": {
        operationId: "InitiateAuth",
        body: schemas.InitiateAuthBody,
        responses: [{200: schemas.AuthResponse}, 400],
        security: publicEndpoint,
        tags: ['Session']
    },
    "POST /user/signin/challenge": {
        operationId: "RespondToAuthChallenge",
        body: schemas.RespondToAuthChallengeBody,
        responses: [{200: schemas.AuthResponse}, 400],
        security: publicEndpoint,
        tags: ['Session']
    },
    "GET /user/session": {
        operationId: "GetSession",
        responses: [{200: schemas.GetSessionResponse}, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Session']
    },
    "POST /user/session": {
        operationId: "RefreshSession",
        responses: [{200: schemas.GetSessionResponse}, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Session']
    },
    "DELETE /user/session": {
        operationId: "SignOut",
        security: authenticatedEndpoint,
        responses: [401, 403],
        tags: ['Session']
    },

    "GET /user/attributes": {
        operationId: "GetUser",
        success: schemas.UserAttributes,
        responses: [401, 403],
        security: authenticatedEndpoint,
        tags: ['Attributes']
    },
    "PUT /user/attributes": {
        operationId: "UpdateUserAttributes",
        body: schemas.UpdateUserAttributesBody,
        success: schemas.UpdateUserAttributesResponse,
        responses: [400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Attributes']
    },
    "DELETE /user/attributes": {
        operationId: "DeleteUserAttributes",
        body: schemas.DeleteUserAttributesBody,
        success: schemas.DeleteUserAttributesResponse,
        responses: [400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Attributes']
    },

    "POST /user/password": {
        operationId: "ChangePassword",
        body: schemas.ChangePasswordBody,
        responses: [{200: schemas.ChangePasswordResponse}, 400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Password']
    },
    "POST /user/password/forgot": {
        operationId: "ForgotPassword",
        body: schemas.ForgotPasswordBody,
        responses: [{200: schemas.ForgotPasswordResponse}, 400],
        security: publicEndpoint,
        tags: ['Password']
    },
    "POST /user/password/confirm": {
        operationId: "ConfirmForgotPassword",
        body: schemas.ConfirmForgotPasswordBody,
        responses: [{200: schemas.ConfirmForgotPasswordResponse}, 400],
        security: publicEndpoint,
        tags: ['Password']
    },

    "GET /user/devices": {
        operationId: "GetDevices",
        body: schemas.GetDevicesBody,
        responses: [{200: schemas.GetDevicesResponse}, 400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Devices']
    },
    "GET /user/device/{id}": {
        operationId: "GetDevice",
        path: {id: schemas.DeviceId},
        responses: [{200: schemas.GetDeviceBody}, 400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Devices']
    },
    "PUT /user/device/{id}": {
        operationId: "UpdateDeviceStatus",
        path: {id: schemas.DeviceId},
        body: schemas.UpdateDeviceStatusBody,
        responses: [{200: schemas.UpdateDeviceStatusResponse}, 400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Devices']
    },
    "PUT /user/device/{id}/confirm": {
        operationId: "ConfirmDevice",
        path: {id: schemas.DeviceId},
        body: schemas.ConfirmDeviceBody,
        responses: [{200: schemas.ConfirmDeviceResponse}, 400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Devices']
    },
    "DELETE /user/device/{id}": {
        operationId: "ForgetDevice",
        path: {id: schemas.DeviceId},
        responses: [{200: schemas.ForgetDeviceResponse}, 400, 401, 403],
        security: authenticatedEndpoint,
        tags: ['Devices']
    },
} as const satisfies RouteMap