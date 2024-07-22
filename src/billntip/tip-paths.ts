import {Type, Type as T} from '@sinclair/typebox';
import {RouteMap} from "@app/lambda";
import * as schemas from "./schemas";
import {Me} from "./schemas";

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
        success: Me,
        responses: [401, 403],
        tags: ['Tip']
    },

    "GET /tip/verification": {
        operationId: "GET /tip/verification",
        success: schemas.KYCDetails,
        responses: [401, 403],
        tags: ['Tip']
    },

    "POST /tip/verification": {
        operationId: "POST /tip/verification",
        body: schemas.VerificationRequest,
        success: schemas.VerificationResponse,
        responses: [400, 401, 403],
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
    },
    //
    // "GET /tip/locations": {
    //     operationId: "GET /tip/locations",
    //     success: Type.Array(schemas.BankAccount),
    //     responses: [401, 403],
    //     tags: ['Tip']
    // }
} as const satisfies RouteMap


