import {Static, Type, Type as T} from '@sinclair/typebox';
import {RouteMap} from "@app/lambda";
import {
    MemberSchema,
    PaymentGatewayQuery,
    TransactionsQuery,
    TransferSchema,
    TxStatus,
    TxType,
    WalletSchema
} from "./schemas";

const Id = {
    id: T.String({description: "Organisation identifier"})
}
const KYCProcessSchema = Type.Object({
    process_id: Type.String({description: "Verification process identifier."}),
    created_at: Type.Number({
        description: "The date and time at which the process has started.",
        examples: [1716814592]
    }),
    processed_at: Type.Number({
        description: "The date and time at which submission processed by the KYC team.",
        examples: [1716814592]
    }),
    status: Type.Union([
        Type.Literal("CREATED"),
        Type.Literal("VALIDATION_ASKED"),
        Type.Literal("VALIDATED"),
        Type.Literal("REFUSED"),
        Type.Literal("OUT_OF_DATE")
    ]),
    refuse_reason: Type.Union([
        Type.Literal("DOCUMENT_DO_NOT_MATCH_USER_DATA"),
        Type.Literal("DOCUMENT_DO_NOT_MATCH_ACCOUNT_DATA"),
        Type.Literal("DOCUMENT_FALSIFIED"),
        Type.Literal("DOCUMENT_HAS_EXPIRED"),
        Type.Literal("DOCUMENT_INCOMPLETE"),
        Type.Literal("DOCUMENT_MISSING"),
        Type.Literal("DOCUMENT_NOT_ACCEPTED"),
        Type.Literal("DOCUMENT_UNREADABLE"),
        Type.Literal("SPECIFIC_CASE"),
        Type.Literal("UNDERAGE_PERSON")
    ]),
    refuse_message: Type.String({description: "Message from the KYC team explaining reason for refusal."})
}, {
    $id: "KYCProcessSchema",
    description: "The KYC Process object is a container tracking KYC document submissions, verification process and outcome."
});
export default {
    "POST /tip/registration": {
        operationId: "Register",
        success: Type.Object({
            invites: Type.Array(MemberSchema)
        }),
        responses: [401, 403],
        tags: ['Tip']
    },

    "GET /tip/invites": {
        operationId: "ListInvites",
        query: {
            accepted: T.Optional(T.Boolean({description: "Show only accepted invites"})),
            rejected: T.Optional(T.Boolean({description: "Show only rejected invites"})),
        },
        success: Type.Array(MemberSchema),
        responses: [401, 403],
        tags: ['Tip']
    },
    "GET /tip/invites/{id}": {
        operationId: "GetInvite",
        path: Id,
        success: MemberSchema,
        responses: [401, 403, 404],
        tags: ['Tip']
    },
    "PUT /tip/invites/{id}": {
        operationId: "AcceptInvite",
        path: Id,
        success: MemberSchema,
        responses: [401, 403, 404],
        tags: ['Tip']
    },
    "DELETE /tip/invites/{id}": {
        operationId: "RejectInvite",
        path: Id,
        success: Type.Optional(MemberSchema),
        responses: [401, 403, 404],
        tags: ['Tip']
    },

    "GET /tip/transactions": {
        operationId: "GetWalletTransactions",
        query: TransactionsQuery,
        success: Type.Object({
            transactions: T.Array(TransferSchema),
            wallet: WalletSchema
        }),
        responses: [401, 403],
        tags: ['Tip']
    },

    "GET /tip/me": {
        operationId: "GetWalletUserInfo",
        success: Type.Object({
            kycLevel: Type.Union([Type.Literal("LIGHT"), Type.Literal("REGULAR")]),
            category: Type.Optional(Type.Union([Type.Literal("PAYER"), Type.Literal("OWNER")])),
            status: Type.Object({
                action_code: Type.String(),
                scope: Type.Object({
                    inflows: Type.Boolean(),
                    outflows: Type.Boolean(),
                })
            }, {
                description: "User regulatory status. See more at https://mangopay.com/docs/concepts/users/policies/blocked-users",
                examples: [
                    {
                        "action_code": "",
                        "scope": {
                            "inflows": false,
                            "outflows": false
                        }
                    },
                    {
                        "action_code": "008702",
                        "scope": {
                            "inflows": true,
                            "outflows": true
                        }
                    },
                ]
            }),
            wallet: Type.Optional(WalletSchema)
        }),
        responses: [401, 403],
        tags: ['Tip']
    },

    "POST /tip/verification": {
        operationId: "VerifyIdentity",
        body: Type.Array(Type.String({maxLength: 2 * 1024 * 1024}), {minItems: 1, maxItems: 2}),
        success: KYCProcessSchema,
        responses: [400, 401, 403],
        tags: ['Tip']
    },

    "GET /tip/verification": {
        operationId: "GetIdentityVerificationStatus",
        success: KYCProcessSchema,
        responses: [401, 403],
        tags: ['Tip']
    }
} as const satisfies RouteMap
