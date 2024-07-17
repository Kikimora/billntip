import {Type, Type as T} from '@sinclair/typebox';
import {RouteMap} from "@app/lambda";
import * as schemas from "./schemas";

export default {
    "POST /tip/registration": {
        operationId: "POST /tip/registration",
        success: Type.Object({
            invites: Type.Array(schemas.MemberSchema)
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
        success: Type.Array(schemas.MemberSchema),
        responses: [401, 403],
        tags: ['Tip']
    },
    "GET /tip/invites/{id}": {
        operationId: "GET /tip/invites",
        path: schemas.OrgId,
        success: schemas.MemberSchema,
        responses: [401, 403, 404],
        tags: ['Tip']
    },
    "PUT /tip/invites/{id}": {
        operationId: "PUT /tip/invites",
        path: schemas.OrgId,
        success: schemas.MemberSchema,
        responses: [401, 403, 404],
        tags: ['Tip']
    },
    "DELETE /tip/invites/{id}": {
        operationId: "DELETE /tip/invites",
        path: schemas.OrgId,
        success: Type.Optional(schemas.MemberSchema),
        responses: [401, 403, 404],
        tags: ['Tip']
    },

    "GET /tip/transactions": {
        operationId: "GET /tip/transactions",
        query: schemas.TransactionsQuery,
        success: Type.Object({
            transactions: T.Array(schemas.Transaction),
            wallet: schemas.AmountSchema
        }),
        responses: [401, 403],
        tags: ['Tip']
    },
    "GET /tip/transactions/{id}": {
        operationId: "GET /tip/transactions/{id}",
        path: schemas.TxId,
        success: Type.Object({
            transaction: schemas.Transaction,
            wallet: schemas.AmountSchema
        }),
        responses: [401, 403, 404],
        tags: ['Tip']
    },
    "POST /tip/transactions": {
        operationId: "POST /tip/transactions",
        body: schemas.CreateTransactionRequest,
        success: Type.Object({
            transaction: schemas.Transaction,
            wallet: schemas.AmountSchema
        }),
        responses: [400, 401, 403],
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
            wallet: Type.Optional(schemas.AmountSchema)
        }),
        responses: [401, 403],
        tags: ['Tip']
    },

    "POST /tip/verification": {
        operationId: "POST /tip/verification",
        body: Type.Array(Type.String({maxLength: 5 * 1024 * 1024}), {minItems: 1, maxItems: 2}),
        success: schemas.KYCProcess,
        responses: [400, 401, 403],
        tags: ['Tip']
    },

    "GET /tip/verification": {
        operationId: "GET /tip/verification",
        success: Type.Partial(schemas.KYCProcess),
        responses: [401, 403],
        tags: ['Tip']
    },

    "GET /tip/accounts": {
        operationId: "GET /tip/accounts",
        query: schemas.BankAccountsQuery,
        success: Type.Array(schemas.BankAccount),
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
        success: schemas.BankAccount,
        responses: [401, 403],
        tags: ['Tip']
    },
    "POST /tip/accounts": {
        operationId: "POST /tip/accounts",
        body: schemas.CreateBankAccountRequest,
        success: schemas.BankAccount,
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
        success: schemas.BankAccount,
        responses: [400, 401, 403],
        tags: ['Tip']
    }
} as const satisfies RouteMap
