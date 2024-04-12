import {RouteMap} from "@app/lambda";
import * as schemas from './schemas';
import {SecurityRequirementObject} from "openapi3-ts/src/model/openapi31";

const authenticated: SecurityRequirementObject[] = [{"Cookie": []}]
const publicEndpoint: SecurityRequirementObject[] = []

export default {
    "POST /user": {
        operationId: "SignUp",
        body: schemas.SignUpBody,
        success: schemas.SignUpResponse,
        security: publicEndpoint
    },
    "PUT /user": {
        operationId: "UpdateUserAttributes",
        body: schemas.UpdateUserAttributesBody,
        success: schemas.UpdateUserAttributesResponse,
        security: authenticated
    },
    "POST /user/confirm": {
        operationId: "ConfirmSignUp",
        body: schemas.ConfirmSignUpBody,
        success: schemas.ConfirmSignUpResponse,
        security: publicEndpoint
    },
    "POST /user/resend_confirmation_code": {
        operationId: "ResendConfirmationCode",
        body: schemas.ResendConfirmationCodeBody,
        success: schemas.ResendConfirmationCodeResponse,
        security: publicEndpoint
    },
    "POST /user/signin": {
        operationId: "InitiateAuth",
        body: schemas.InitiateAuthBody,
        success: schemas.InitiateAuthResponse,
        security: publicEndpoint
    },
    "POST /user/signin/challenge": {
        operationId: "RespondToAuthChallenge",
        body: schemas.RespondToAuthChallengeBody,
        success: schemas.RespondToAuthChallengeResponse,
        security: publicEndpoint
    },
    "POST /user/signout": {
        operationId: "SignOut",
        security: authenticated
    },
    "POST /user/password": {
        operationId: "ChangePassword",
        body: schemas.ChangePasswordBody,
        success: schemas.ChangePasswordResponse,
        security: authenticated
    },
    "POST /user/password/forgot": {
        operationId: "ForgotPassword",
        body: schemas.ForgotPasswordBody,
        success: schemas.ForgotPasswordResponse,
        security: publicEndpoint
    },
    "POST /user/password/confirm": {
        operationId: "ConfirmForgotPassword",
        body: schemas.ConfirmForgotPasswordBody,
        success: schemas.ConfirmForgotPasswordResponse,
        security: publicEndpoint
    },
    "GET /user/session": {
        operationId: "GetSession",
        body: schemas.GetSessionBody,
        success: schemas.GetSessionResponse,
        responses: {
            200: schemas.GetSessionResponse
        },
        security: authenticated,
    },
    "GET /user/devices": {
        operationId: "GetDevices",
        body: schemas.GetDevicesBody,
        success: schemas.GetDevicesResponse,
        security: authenticated
    },
    "GET /user/device/{id}": {
        operationId: "GetDevice",
        path: {id: schemas.DeviceId},
        success: schemas.GetDeviceBody,
        security: authenticated
    },
    "PUT /user/device/{id}": {
        operationId: "UpdateDeviceStatus",
        path: {id: schemas.DeviceId},
        body: schemas.UpdateDeviceStatusBody,
        success: schemas.UpdateDeviceStatusResponse,
        security: authenticated
    },
    "PUT /user/device/{id}/confirm": {
        operationId: "ConfirmDevice",
        path: {id: schemas.DeviceId},
        body: schemas.ConfirmDeviceBody,
        success: schemas.ConfirmDeviceResponse,
        security: authenticated
    },
    "DELETE /user/device/{id}": {
        operationId: "ForgetDevice",
        path: {id: schemas.DeviceId},
        success: schemas.ForgetDeviceResponse,
        security: authenticated
    },
} as const satisfies RouteMap