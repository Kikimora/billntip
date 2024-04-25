import {Type as T} from "@sinclair/typebox";

const ClientMetadata = T.Optional(T.Record(
    T.String({maxLength: 20}),
    T.String({maxLength: 2048}))
);

const UserAttributeNames = T.Union([
    T.Literal("phone_number", {description: "Phone number as defined by E.164 - The international public telecommunication numbering plan."}),
    T.Literal("given_name", {description: "Given name(s) or first name(s)."}),
    T.Literal("family_name", {description: "Surname(s) or last name(s)."}),
    T.Literal("birthdate", {description: "Birthday, represented as an ISO 8601-1 YYYY-MM-DD format."}),
    T.Literal("address", {description: "Preferred postal address, in the format defined by section 5.1.1 of OpenID Connect Core 1.0 incorporating errata set 2."}),
    T.Literal("picture", {description: "URL of the profile picture."}),
    T.Literal("custom:tos", {description: "JSON with two field {general: boolean, privacy: boolean}"}),
    T.Literal("custom:data", {description: "User data in any suitable format."}),
    T.Literal("custom:nationality", {description: "Nationality as a country code according to ISO 3166."}),
    T.String({maxLength: 20})
])

//Cognito no username attributes at all.
//Add user to recipients group.
//Required and Optional fields, Emails with templates.
//Send invites.

//Cognito - no username attributes and aliases
//Store user attributes in DynamoDb
//At login - map username to userid, don't use 'sub'
//At token generation - put user attributes into the token.

export const MaxAttributes = 50
export const UserAttributes = T.Array(
    T.Object({
        name: UserAttributeNames,
        value: T.String({maxLength: 2048}),
        verified: T.Optional(T.Boolean({
            description: "Indicate that user has confirmed the attribute (e.g. validated email with a code)."
        }))
    }), {maxItems: MaxAttributes})

export const SignUpBody = T.Object({
    username: T.String(),
    password: T.String(),
    userAttributes: T.Optional(UserAttributes),
    clientMetadata: ClientMetadata,
    validationData: T.Optional(UserAttributes),
}, {$id: "SignUpBody"});

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
}, {
    $id: 'SignUpResponse'
});

export const UpdateUserAttributesBody = T.Object({
    clientMetadata: ClientMetadata,
    userAttributes: UserAttributes
}, {$id: 'UpdateUserAttributesBody'});
export const UpdateUserAttributesResponse = T.Object({
    codeDeliveryDetailsList: T.Optional(T.Array(T.Object({
        destination: T.Optional(T.String()),
        deliveryMedium: T.Optional(T.Union([
            T.Literal("SMS"), T.Literal("EMAIL"), T.String()
        ])),
        attributeName: T.Optional(T.String())
    })))
}, {$id: 'UpdateUserAttributesResponse'});
export const DeleteUserAttributesBody = T.Object({
        userAttributesNames: T.Array(UserAttributeNames)
    },
    {$id: 'DeleteUserAttributesBody'});
export const DeleteUserAttributesResponse = T.Object({}, {$id: 'DeleteUserAttributesResponse'});


export const ConfirmSignUpBody = T.Object({
    username: T.String(),
    confirmationCode: T.String(),
    clientMetadata: ClientMetadata,
}, {$id: 'ConfirmSignUpBody'});
export const ConfirmSignUpResponse = T.Null();

export const ResendConfirmationCodeBody = T.Object({
    username: T.String(),
    clientMetadata: ClientMetadata,
}, {$id: 'ResendConfirmationCodeBody'});
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
}, {$id: 'InitiateAuthBody'});
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
}, {$id: 'RespondToAuthChallengeBody'});
export const RespondToAuthChallengeResponse = T.Null();
export const ChangePasswordBody = T.Object({
    previousPassword: T.String(),
    proposedPassword: T.String(),
}, {$id: 'ChangePasswordBody'});
export const ChangePasswordResponse = T.Null();
export const ForgotPasswordBody = T.Object({
    username: T.String(),
    clientMetadata: ClientMetadata,
}, {$id: 'ForgotPasswordBody'});
export const ForgotPasswordResponse = T.Null();
export const ConfirmForgotPasswordBody = T.Object({
    username: T.String(),
    clientMetadata: ClientMetadata,
    password: T.String(),
    confirmationCode: T.String(),
}, {$id: 'ConfirmForgotPasswordBody'});
export const ConfirmForgotPasswordResponse = T.Null();

export const GetSessionResponse = T.Object({
    accessToken: T.String(),
    idToken: T.String(),
    profile: T.Object({}),
    expiresAt: T.Number()
}, {$id: 'GetSessionResponse'});

export const Cookie = T.String({pattern: 'SID=.*'})

export const DeviceId = T.String({description: "Device Key"})
export const GetDevicesBody = T.Object({
    paginationToken: T.Optional(T.String()),
    limit: T.Optional(T.Number({minimum: 1})),
}, {$id: 'GetDevicesBody'});
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
}, {$id: 'GetDeviceBody'});
export const UpdateDeviceStatusBody = T.Object({
    deviceRememberedStatus: T.Optional(T.Union([
        T.Literal("remembered"),
        T.Literal("not_remembered"),
    ]))
}, {$id: 'UpdateDeviceStatusBody'});
export const UpdateDeviceStatusResponse = T.Null();
export const ConfirmDeviceBody = T.Object({
    deviceName: T.Optional(T.String()),
    deviceSecretVerifierConfig: T.Optional(T.Object({
        passwordVerifier: T.Optional(T.String()),
        salt: T.Optional(T.String()),
    }))
}, {$id: 'ConfirmDeviceBody'});
export const ConfirmDeviceResponse = T.Null();
export const ForgetDeviceResponse = T.Null();