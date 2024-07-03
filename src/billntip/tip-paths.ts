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
    "GET /tip/invite/{id}": {
        operationId: "GetInvite",
        path: Id,
        success: MemberSchema,
        responses: [401, 403, 404],
        tags: ['Tip']
    },
    "PUT /tip/invite/{id}": {
        operationId: "AcceptInvite",
        path: Id,
        success: MemberSchema,
        responses: [401, 403, 404],
        tags: ['Tip']
    },
    "DELETE /tip/invite/{id}": {
        operationId: "RejectInvite",
        path: Id,
        success: Type.Optional(MemberSchema),
        responses: [401, 403, 404],
        tags: ['Tip']
    },
    "GET /tip/wallet": {
        operationId: "GetWalletDetails",
        success: WalletSchema,
        responses: [401, 403],
        tags: ['Tip']
    },
    "GET /tip/wallet/transactions": {
        operationId: "GetWalletTransactions",
        query: TransactionsQuery,
        success: Type.Object({
            transactions: T.Array(TransferSchema),
            wallet: WalletSchema
        }),
        responses: [401, 403],
        tags: ['Tip']
    },
} as const satisfies RouteMap
