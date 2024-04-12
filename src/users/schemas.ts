import {Type as T} from "@sinclair/typebox";

const ClientMetadata = T.Optional(T.Record(T.String(), T.String()));
const UserAttributes = T.Array(
    T.Object({
        name: T.String(),
        value: T.String()
    }))

export const SignUpBody = T.Object({
    username: T.String(),
    password: T.String(),
    userAttributes: T.Optional(UserAttributes),
    clientMetadata: ClientMetadata,
    validationData: T.Optional(UserAttributes),
});

export const SignUpResponse = T.Object({
    userConfirmed: T.Optional(T.Boolean()),
    codeDeliveryDetails: T.Optional(T.Object({
        destination: T.Optional(T.String()),
        deliveryMedium: T.Optional(T.Union([
            T.Literal("SMS"), T.Literal("EMAIL"), T.String()
        ])),
        attributeName: T.Optional(T.String())
    })),
    userSub: T.Optional(T.String())
});

export const UpdateUserAttributesBody = T.Object({
    clientMetadata: ClientMetadata,
    userAttributes: UserAttributes
});
export const UpdateUserAttributesResponse = T.Object({
    codeDeliveryDetailsList: T.Optional(T.Array(T.Object({
        destination: T.Optional(T.String()),
        deliveryMedium: T.Optional(T.Union([
            T.Literal("SMS"), T.Literal("EMAIL"), T.String()
        ])),
        attributeName: T.Optional(T.String())
    })))
});
export const ConfirmSignUpBody = T.Object({
    username: T.String(),
    confirmationCode: T.String(),
    clientMetadata: ClientMetadata,
});
export const ConfirmSignUpResponse = T.Null();

export const ResendConfirmationCodeBody = T.Object({
    username: T.String(),
    clientMetadata: ClientMetadata,
});
export const ResendConfirmationCodeResponse = T.Null();
export const InitiateAuthBody = T.Object({
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
});
export const InitiateAuthResponse = T.Null();
export const RespondToAuthChallengeBody = T.Object({
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
});
export const RespondToAuthChallengeResponse = T.Null();
export const ChangePasswordBody = T.Object({
    previousPassword: T.String(),
    proposedPassword: T.String(),
});
export const ChangePasswordResponse = T.Null();
export const ForgotPasswordBody = T.Object({
    username: T.String(),
    clientMetadata: ClientMetadata,
});
export const ForgotPasswordResponse = T.Null();
export const ConfirmForgotPasswordBody = T.Object({
    username: T.String(),
    clientMetadata: ClientMetadata,
    password: T.String(),
    confirmationCode: T.String(),
});
export const ConfirmForgotPasswordResponse = T.Null();
export const GetSessionBody = T.Null();
export const GetSessionResponse = T.Object({
    accessToken: T.String(),
    idToken: T.String(),
    profile: T.Object({}),
    expiresAt: T.Number()
});

export const DeviceId = T.String()
export const GetDevicesBody = T.Object({
    paginationToken: T.Optional(T.String()),
    limit: T.Optional(T.Number({minimum: 1})),
});
export const GetDevicesResponse = T.Null();
export const GetDeviceBody = T.Object({
    device: T.Object({
        deviceAttributes: T.Array(T.Object({
                name: T.String(),
                value: T.String()
            }
        )),
        deviceCreateDate: T.Number(),
        deviceKey: T.String(),
        deviceLastAuthenticatedDate: T.Number(),
        deviceLastModifiedDate: T.Number()
    })
});
export const UpdateDeviceStatusBody = T.Object({
    deviceRememberedStatus: T.Optional(T.Union([
        T.Literal("remembered"),
        T.Literal("not_remembered"),
    ]))
});
export const UpdateDeviceStatusResponse = T.Null();
export const ConfirmDeviceBody = T.Object({
    deviceName: T.Optional(T.String()),
    deviceSecretVerifierConfig: T.Optional(T.Object({
        passwordVerifier: T.Optional(T.String()),
        salt: T.Optional(T.String()),
    }))
});
export const ConfirmDeviceResponse = T.Null();
export const ForgetDeviceResponse = T.Null();