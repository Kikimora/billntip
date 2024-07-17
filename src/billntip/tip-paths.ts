import {Type, Type as T} from '@sinclair/typebox';
import {RouteMap} from "@app/lambda";
import {
    BankAccountsQuery, OrgId,
    MemberSchema,
    TransactionsQuery,
    TransferSchema,
    WalletSchema, KYCProcessSchema, BankAccount, CreateBankAccountRequest, AmountSchema
} from "./schemas";

export default {
    "POST /tip/registration": {
        operationId: "POST /tip/registration",
        success: Type.Object({
            invites: Type.Array(MemberSchema)
        }),
        responses: [401, 403],
        tags: ['Tip']
    },

    "GET /tip/invites": {
        operationId: "GET /tip/invites",
        query: {
            accepted: T.Optional(T.Boolean({description: "Show only accepted invites"})),
            rejected: T.Optional(T.Boolean({description: "Show only rejected invites"})),
        },
        success: Type.Array(MemberSchema),
        responses: [401, 403],
        tags: ['Tip']
    },
    "GET /tip/invites/{id}": {
        operationId: "GET /tip/invites",
        path: OrgId,
        success: MemberSchema,
        responses: [401, 403, 404],
        tags: ['Tip']
    },
    "PUT /tip/invites/{id}": {
        operationId: "PUT /tip/invites",
        path: OrgId,
        success: MemberSchema,
        responses: [401, 403, 404],
        tags: ['Tip']
    },
    "DELETE /tip/invites/{id}": {
        operationId: "DELETE /tip/invites",
        path: OrgId,
        success: Type.Optional(MemberSchema),
        responses: [401, 403, 404],
        tags: ['Tip']
    },

    "GET /tip/transactions": {
        operationId: "GET /tip/transactions",
        query: TransactionsQuery,
        success: Type.Object({
            transactions: T.Array(TransferSchema),
            wallet: AmountSchema
        }),
        responses: [401, 403],
        tags: ['Tip']
    },

    "GET /tip/me": {
        operationId: "GET /tip/me",
        success: Type.Object({
            kyc_level: Type.Union([Type.Literal("LIGHT"), Type.Literal("REGULAR")]),
            proof_of_identity: Type.Boolean(),
            proof_of_address: Type.Boolean(),
            category: Type.Optional(Type.Union([Type.Literal("PAYER"), Type.Literal("OWNER")])),
            regulatory_status: Type.Object({
                action_code: Type.String(),
                blocked: Type.Object({
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
            wallet: Type.Optional(AmountSchema)
        }),
        responses: [401, 403],
        tags: ['Tip']
    },

    "POST /tip/verification": {
        operationId: "POST /tip/verification",
        body: Type.Array(Type.String({maxLength: 5 * 1024 * 1024}), {minItems: 1, maxItems: 2}),
        success: KYCProcessSchema,
        responses: [400, 401, 403],
        tags: ['Tip']
    },

    "GET /tip/verification": {
        operationId: "GET /tip/verification",
        success: Type.Partial(KYCProcessSchema),
        responses: [401, 403],
        tags: ['Tip']
    },

    "GET /tip/accounts": {
        operationId: "GET /tip/accounts",
        query: BankAccountsQuery,
        success: Type.Array(BankAccount),
        responses: [401, 403],
        tags: ['Tip']
    },
    "GET /tip/accounts/{id}": {
        operationId: "GET /tip/accounts/{id}",
        path: {
            id: Type.String({
                description: "Bank account id."
            })
        },
        success: BankAccount,
        responses: [401, 403],
        tags: ['Tip']
    },
    "POST /tip/accounts": {
        operationId: "POST /tip/accounts",
        body: CreateBankAccountRequest,
        success: BankAccount,
        responses: [400, 401, 403],
        tags: ['Tip']
    },
    "DELETE /tip/accounts/{id}": {
        operationId: "DELETE /tip/accounts/{id}",
        path: {
            id: Type.String({
                description: "Bank account id."
            })
        },
        success: BankAccount,
        responses: [400, 401, 403],
        tags: ['Tip']
    }
} as const satisfies RouteMap
