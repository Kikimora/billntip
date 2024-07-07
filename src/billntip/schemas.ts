import {Static, Type as T, Type} from "@sinclair/typebox";

const ShortUserInfo = Type.Object({
    email: Type.String({description: "User email"}),
    first_name: Type.String({description: "User first name"}),
    last_name: Type.String({description: "User last name"}),
});

export const MemberSchema = Type.Object({
    accepted_at: Type.Optional(Type.Number({
        description: "Invite acceptance timestamp", examples: [1716814592]
    })),
    invited_at: Type.Number({
        description: "Invite creation timestamp", examples: [1716814592]
    }),
    invited_by: ShortUserInfo,
    org: Type.Object({
            id: Type.String({description: "Target organisation identifier"}),
            title: Type.String({description: "Target organisation name"})
        }, {description: "Target organisation"}
    ),
    rejected_at: Type.Optional(Type.Number({description: "Rejection timestamp", examples: [1716814592]})),
    role: Type.Union([
        Type.Literal("admin"),
        Type.Literal("member")
    ], {description: "Member role in the organisation"})
}, {$id: "MemberSchema", description: "Organisation member"})

const AmountSchema = Type.Object({
    amount: Type.Number({
        description: 'An amount of money in the smallest sub-division of the currency (e.g., EUR 12.60 would be represented as 1260 whereas JPY 12 would be represented as just 12).',
        examples: [10]
    }),
    currency: Type.String({
        description: "Currency in the ISO_4217 format",
        examples: ["EUR"]
    }),
}, {$id: "AmountSchema"})
export const TxType = T.Union([T.Literal("PAYIN"), T.Literal("TRANSFER"), T.Literal("CONVERSION"), T.Literal("PAYOUT"), T.Literal("CARD_VALIDATION")], {$id: "TxType"});
export const TxStatus = T.Union([T.Literal("CREATED"), T.Literal("SUCCEEDED"), T.Literal("FAILED")], {$id: "TxStatus"});

export const WalletSchema = Type.Object({
    id: Type.String({
        description: "The unique identifier of the object.",
        examples: ["wlt_m_01HYX1ZERF8SC8D8SGZSHANCA7"]
    }),
    created_at: Type.Number({
        description: "The date and time at which the object was created.",
        examples: [1716814592]
    }),
    description: Type.Optional(Type.String({
        description: "",
        examples: [""]
    })),
    balance: AmountSchema,
}, {
    $id: "WalletSchema",
    description: "The digital e-wallet on which funds are stored."
})
export const TransferSchema = Type.Object({
    id: Type.String({
        description: "The unique identifier of the object.",
        examples: ["xfer_m_01HYX2AZM381923J2DNG5YV50B"]
    }),
    created_at: Type.Number({
        description: "The date and time at which the object was created.",
        examples: [1716814592]
    }),
    org: Type.Optional(Type.String({description:"Organisation id"})),
    loc: Type.Optional(Type.String({description:"Location id"})),
    debit: AmountSchema,
    credit: AmountSchema,
    fee: AmountSchema,
    status: TxStatus,
    result_code: Type.String({
        description: "The code indicating the result of the operation. This information is mostly used to handle errors or for filtering purposes.",
        examples: ['101108']
    }),
    result_message: Type.String({
        description: "The explanation of the result code.",
        examples: ['Transaction refused: the Debited Wallet and the Credited Wallet must be different']
    }),
    execution_date: Type.Optional(Type.Number({
        description: "The date and time at which the status changed to SUCCEEDED, indicating that the transaction occurred. The statuses CREATED and FAILED return an ExecutionDate of null.",
        examples: [1716814592]
    })),
    type: TxType,
}, {
    $id: "TransferSchema",
    description: "A transfer is a request to relocate funds from one wallet to another."
})

export const PaymentGatewayQuery = {
    sort: Type.Optional(Type.String({
        description: "The column to sort against and direction - only `created_at` (or `date` for the events) is available and ASC or DESC for the direction.",
        examples: ['created_at:ASC'],
        $id: "PaymentGatewaySort"
    })),
    before: Type.Optional(Type.Number({
        description: "To return only resources that have `created_at` BEFORE this date",
        examples: [1716814592],
        $id: "PaymentGatewayBefore"
    })),
    after: Type.Optional(Type.Number({
        description: "To return only resources that have `created_at` AFTER this date",
        examples: [1716814592],
        $id: "PaymentGatewayAfter"
    })),
    page: Type.Optional(Type.Number({
        description: "The page number of results you wish to return",
        default: 1,
        examples: [1],
        $id: "PaymentGatewayPage"
    })),
    per_page: Type.Optional(Type.Number({
        description: "The number of results to return per page: Max 100",
        examples: [10],
        default: 10,
        minimum: 1,
        maximum: 10,
        $id: "PaymentGatewayPerPage"
    }))
} as const

export const TransactionsQuery = {
    ...PaymentGatewayQuery,
    status: Type.Optional(TxStatus),
    type: Type.Optional(TxType)
}
const TTransactionsQuery = Type.Object(TransactionsQuery)
export type TransactionsQuery = Static<typeof TTransactionsQuery>