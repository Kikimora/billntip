import {RouteMap} from "@app/lambda";
import * as schemas from './schemas';
import {SecurityRequirementObject} from "openapi3-ts/src/model/openapi31";

const authenticated: SecurityRequirementObject[] = [{"Cookie": []}]
const publicEndpoint: SecurityRequirementObject[] = []

export default {
    "POST /user": {
        operationId: "SignUp",
        body: schemas.SignUpBody,
        response: [{200: schemas.SignUpResponse}, 400],
        security: publicEndpoint,
    },
    "PUT /user": {
        operationId: "UpdateUserAttributes",
        body: schemas.UpdateUserAttributesBody,
        response: [{200: schemas.UpdateUserAttributesResponse}, 400, 401, 403],
        security: authenticated,
        failures: [400]
    },
    "POST /user/confirm": {
        operationId: "ConfirmSignUp",
        body: schemas.ConfirmSignUpBody,
        response: [{200: schemas.ConfirmSignUpResponse}, 400],
        security: publicEndpoint
    },
    "POST /user/resend_confirmation_code": {
        operationId: "ResendConfirmationCode",
        body: schemas.ResendConfirmationCodeBody,
        response: [{200: schemas.ResendConfirmationCodeResponse}, 400],
        security: publicEndpoint
    },
    "POST /user/signin": {
        operationId: "InitiateAuth",
        body: schemas.InitiateAuthBody,
        response: [{200: schemas.InitiateAuthResponse}, 400],
        security: publicEndpoint
    },
    "POST /user/signin/challenge": {
        operationId: "RespondToAuthChallenge",
        body: schemas.RespondToAuthChallengeBody,
        response: [{200: schemas.RespondToAuthChallengeResponse}, 400],
        security: publicEndpoint
    },
    "POST /user/signout": {
        operationId: "SignOut, 400, 401, 403",
        security: authenticated
    },
    "POST /user/password": {
        operationId: "ChangePassword",
        body: schemas.ChangePasswordBody,
        response: [{200: schemas.ChangePasswordResponse}, 400, 401, 403],
        security: authenticated
    },
    "POST /user/password/forgot": {
        operationId: "ForgotPassword",
        body: schemas.ForgotPasswordBody,
        response: [{200: schemas.ForgotPasswordResponse}, 400],
        security: publicEndpoint
    },
    "POST /user/password/confirm": {
        operationId: "ConfirmForgotPassword",
        body: schemas.ConfirmForgotPasswordBody,
        response: [{200: schemas.ConfirmForgotPasswordResponse}, 400],
        security: publicEndpoint
    },
    "GET /user/session": {
        operationId: "GetSession",
        body: schemas.GetSessionBody,
        response: [{200: schemas.GetSessionResponse}, 400, 401, 403],
        security: authenticated,
    },
    "GET /user/devices": {
        operationId: "GetDevices",
        body: schemas.GetDevicesBody,
        response: [{200: schemas.GetDevicesResponse}, 400, 401, 403],
        security: authenticated
    },
    "GET /user/device/{id}": {
        operationId: "GetDevice",
        path: {id: schemas.DeviceId},
        response: [{200: schemas.GetDeviceBody}, 400, 401, 403],
        security: authenticated
    },
    "PUT /user/device/{id}": {
        operationId: "UpdateDeviceStatus",
        path: {id: schemas.DeviceId},
        body: schemas.UpdateDeviceStatusBody,
        response: [{200: schemas.UpdateDeviceStatusResponse}, 400, 401, 403],
        security: authenticated
    },
    "PUT /user/device/{id}/confirm": {
        operationId: "ConfirmDevice",
        path: {id: schemas.DeviceId},
        body: schemas.ConfirmDeviceBody,
        response: [{200: schemas.ConfirmDeviceResponse}, 400, 401, 403],
        security: authenticated
    },
    "DELETE /user/device/{id}": {
        operationId: "ForgetDevice",
        path: {id: schemas.DeviceId},
        response: [{200: schemas.ForgetDeviceResponse}, 400, 401, 403],
        security: authenticated
    },
} as const satisfies RouteMap