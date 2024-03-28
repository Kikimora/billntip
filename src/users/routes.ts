import {Type as T} from '@sinclair/typebox';
import {RouteMap} from "@app/lambda";

const ClientMetadata = T.Optional(T.Record(T.String(), T.String()));
const UserAttributes = T.Optional(
    T.Array(
        T.Object({
            name: T.String(),
            value: T.String()
        }))
)

export default {
    "POST /user": {
        body: T.Object({
            username: T.String(),
            password: T.String(),
            userAttributes: UserAttributes,
            clientMetadata: ClientMetadata,
            validationData: UserAttributes,
        }),
        res: T.Null(),
        operationId: "SignUp",
        public: true
    },
    "PUT /user": {
        body: T.Object({
            clientMetadata: ClientMetadata,
            userAttributes: UserAttributes
        }),
        res: T.Null(),
        operationId: "UpdateUserAttributes",
        public: false
    },
    "POST /user/confirm": {
        operationId: "ConfirmSignUp",
        body: T.Object({
            username: T.String(),
            confirmationCode: T.String(),
            clientMetadata: ClientMetadata,
        }),
        res: T.Null(),
        public: true
    },
    "POST /user/resend_confirmation_code": {
        body: T.Object({
            username: T.String(),
            clientMetadata: ClientMetadata,
        }),
        res: T.Null(),
        public: true
    },
    "POST /user/signin": {
        operationId: "InitiateAuth",
        body: T.Object({
            authFlow: T.Union([
                T.Literal("ADMIN_NO_SRP_AUTH"),
                T.Literal("ADMIN_USER_PASSWORD_AUTH"),
                T.Literal("CUSTOM_AUTH"),
                T.Literal("REFRESH_TOKEN"),
                T.Literal("REFRESH_TOKEN_AUTH"),
                T.Literal("USER_PASSWORD_AUTH"),
                T.Literal("USER_SRP_AUTH")
            ]),
            authParameters: T.Intersect([
                T.Partial(T.Record(
                    T.Union([
                        T.Literal("DEVICE_KEY"),
                        T.Literal("PASSWORD"),
                        T.Literal("REFRESH_TOKEN"),
                        T.Literal("SRP_A"),
                    ]),
                    T.String())
                ),
                T.Record(
                    T.Union([T.Literal("USERNAME")]),
                    T.String()
                )]),
            clientMetadata: ClientMetadata,
        }),
        res: T.Null(),
        public: true
    },
    "POST /user/signin/challenge": {
        body: T.Object({
            challengeName: T.Union([
                T.Literal("SMS_MFA"),
                T.Literal("SOFTWARE_TOKEN_MFA"),
                T.Literal("SELECT_MFA_TYPE"),
                T.Literal("MFA_SETUP"),
                T.Literal("PASSWORD_VERIFIER"),
                T.Literal("CUSTOM_CHALLENGE"),
                T.Literal("DEVICE_SRP_AUTH"),
                T.Literal("DEVICE_PASSWORD_VERIFIER"),
                T.Literal("ADMIN_NO_SRP_AUTH"),
                T.Literal("NEW_PASSWORD_REQUIRED")
            ]),
            challengeResponses: T.Intersect([
                T.Partial(T.Record(
                    T.Union([
                        T.Literal("DEVICE_KEY"),
                        T.Literal("SMS_MFA_CODE"),
                        T.Literal("PASSWORD_CLAIM_SIGNATURE"),
                        T.Literal("PASSWORD_CLAIM_SECRET_BLOCK"),
                        T.Literal("TIMESTAMP"),
                        T.Literal("ANSWER"),
                        T.Literal("NEW_PASSWORD"),
                        T.Literal("SOFTWARE_TOKEN_MFA_CODE"),
                        T.Literal("SRP_A"),
                        T.Literal("SESSION"),
                    ]),
                    T.String())),
                T.Record(
                    T.Union([
                        T.Literal("USERNAME")
                    ]),
                    T.String())
            ]),
            clientMetadata: ClientMetadata,
            session: T.Optional(T.String())
        }),
        res: T.Null(),
        operationId: "RespondToAuthChallenge",
        public: true
    },
    "POST /user/signout": {
        operationId: "SignOut",
        body: T.Null(),
        res: T.Null(),
        public: false
    },
    "POST /user/password": {
        operationId: "ChangePassword",
        body: T.Object({
            previousPassword: T.String(),
            proposedPassword: T.String(),
        }),
        res: T.Null(),
        public: false
    },

    "POST /user/password/forgot": {
        operationId: "ForgotPassword",
        body: T.Object({
            username: T.String(),
            clientMetadata: ClientMetadata,
        }),
        res: T.Null(),
        public: true
    },
    "POST /user/password/confirm": {
        operationId: "ConfirmForgotPassword",
        body: T.Object({
            username: T.String(),
            clientMetadata: ClientMetadata,
            password: T.String(),
            confirmationCode: T.String(),
        }),
        res: T.Null(),
        public: true
    },
    "GET /user/session": {
        operationId: "GetSession",
        body: T.Null(),
        res: T.Null(),// components.schemas.SessionResponse
        public: false,
    },
    "GET /user/devices": {
        operationId: "GetDevices",
        body: T.Object({
            paginationToken: T.Optional(T.String()),
            limit: T.Optional(T.Number({minimum: 1})),
        }),
        res: T.Null(),
        public: false
    },
    "GET /user/device/{id}": {
        operationId: "UpdateDevice",
        body: T.Object({
            deviceRememberedStatus: T.Optional(T.Union([
                T.Literal("remembered"),
                T.Literal("not_remembered"),
            ]))
        }),
        res: T.Null(),
        public: false
    },
    "PUT /user/device/{id}": {
        operationId: "UpdateDeviceStatus",
        body: T.Object({
            deviceRememberedStatus: T.Optional(T.Union([
                T.Literal("remembered"),
                T.Literal("not_remembered"),
            ]))
        }),
        res: T.Null(),
        public: false
    },
    "PUT /user/device/{id}/confirm": {
        operationId: "ConfirmDevice",
        body: T.Object({
            deviceName: T.Optional(T.String()),
            deviceSecretVerifierConfig: T.Optional(T.Object({
                passwordVerifier: T.Optional(T.String()),
                salt: T.Optional(T.String()),
            }))
        }),
        res: T.Null(),
        public: false
    },
    "DELETE /user/device/{id}": {
        operationId: "ForgetDevice",
        body: T.Null(),
        res: T.Null(),
        public: false
    },
} as const satisfies RouteMap