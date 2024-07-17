import {Static, Type as T, Type} from "@sinclair/typebox";
import {TaggedUnion} from "@app/lambda/tagged_union";

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

export const AmountSchema = Type.Object({
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
        description: "Wallet description",
        examples: ["Basic wallet holding user funds."]
    })),
    balance: AmountSchema,
}, {
    $id: "WalletSchema",
    description: "The digital e-wallet on which funds are stored."
})
export const Transaction = Type.Object({
    id: Type.String({
        description: "The unique identifier of the object.",
        examples: ["xfer_m_01HYX2AZM381923J2DNG5YV50B"]
    }),
    created_at: Type.Number({
        description: "The date and time at which the object was created.",
        examples: [1716814592]
    }),
    org: Type.Optional(Type.String({description: "Organisation id"})),
    loc: Type.Optional(Type.String({description: "Location id"})),
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
    $id: "TransactionSchema",
    description: "A transfer is a request to relocate funds from one wallet to another."
})
export type Transaction = Static<typeof Transaction>
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

export const BankAccountsQuery = {
    ...PaymentGatewayQuery,
    active: Type.Optional(Type.Boolean({
        description: "Whether or not the Bank Account is active."
    }))
}
const TBankAccountsQuery = Type.Object(BankAccountsQuery)
export type BankAccountsQuery = Static<typeof TBankAccountsQuery>

export const OrgId = {
    id: T.String({description: "Organisation identifier"})
}

export const TxId = {
    id: T.String({
        description: "Transaction identifier",
        examples: ["po_m_01J31CGYNP3NBXGVQJF7DBA7QT", "xfer_m_01J30D359GWGMYN12YFJJH03YP", "payin_m_01J30C0NDB6CSBYF4GZXFK1B5N"]
    })
}

export const KYCProcess = Type.Object({
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
        Type.Literal("NOT_STARTED"),
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
    $id: "KYCProcess",
    description: "The KYC Process object is a container tracking KYC document submissions, verification process and outcome."
});

export type KYCProcess = Static<typeof KYCProcess>

const AccountNumber = Type.String({
    description: "The account number of the bank account."
});
const BIC = Type.String({
    description: "The BIC (international identifier of the bank)."
});
const USBankAccount = Type.Object({
    type: Type.Literal("US", {description: "For accounts registered in the United States "}),
    account_number: AccountNumber,
    aba: Type.String({
        description: "The American Banking Association (ABA) routing number for US-type bank accounts."
    }),
    deposit_type: Type.Optional(Type.Union([
        Type.Literal("CHECKING"),
        Type.Literal("SAVINGS"),
    ], {
        description: "The deposit type for US-type bank accounts."
    })),
}, {$id: 'USBankAccount'})
const IBANBankAccount = Type.Object({
    type: Type.Literal("IBAN", {description: "For accounts registered in countries that use IBAN"}),
    iban: Type.String({
        description: "The IBAN (international bank account number) of the bank account."
    }),
    bic: Type.Optional(BIC),
}, {$id: 'IBANBankAccount'})
const CABankAccount = Type.Object({
    type: Type.Literal("CA", {description: "For accounts registered in Canada"}),
    account_number: AccountNumber,
    bank_name: Type.String({
        description: "The name of the Canadian bank for CA-type bank accounts."
    }),
    branch_code: Type.String({
        description: "The 5-digit number assigned to branches of Canadian financial institutions, for CA-type bank accounts."
    }),
    institution_number: Type.String({
        description: "The 3-digit number assigned to Canadian financial institutions, for CA-type bank accounts."
    })
}, {$id: 'CABankAccount'})
const GBBankAccount = Type.Object({
    type: Type.Literal("GB", {description: "For accounts registered in the United Kingdom"}),
    account_number: AccountNumber,
    sort_code: Type.String({
        description: "The 6-digit sort code, assigned to UK financial institutions, for GB-type bank accounts."
    })
}, {$id: 'GBBankAccount'})
const OtherBankAccount = Type.Object({
    type: Type.Literal("OTHER", {description: "For accounts registered in countries that do not use IBAN (and are not US, CA, GB)."}),
    account_number: AccountNumber,
    bic: BIC,
    country: Type.String({
        maxLength: 2,
        description: "Bank country code in the ISO 3166-1 alpha-2 format."
    }),
}, {$id: 'OtherBankAccount'})
const BankAccountOwner = Type.Object({
    name: Type.String({
        description: "The full name of the owner of the bank account. (Format: FirstName LastName)"
    }),
    address_line1: Type.String({
        maxLength: 255,
        description: "The first line of the address."
    }),
    address_line2: Type.Optional(Type.String({
        maxLength: 255,
        description: "The second line of the address."
    })),
    city: Type.String({
        maxLength: 255,
        description: "The city of the address."
    }),
    region: Type.Optional(Type.String({
        maxLength: 255,
        description: "The region of the address. This field is optional except if the Country is US, CA, or MX."
    })),
    zip: Type.String({
        maxLength: 255,
        description: "The postal code of the address. The postal code can contain the following characters: alphanumeric, dashes, and spaces."
    }),
    country: Type.String({
        maxLength: 2,
        description: "Country code in the ISO 3166-1 alpha-2 format."
    })
}, {
    $id: 'BankAccountOwner',
    description: "Bank account owner details"
});

export const BankAccount = Type.Object({
        id: Type.String({
            description: "The unique identifier of the object."
        }),
        owner: BankAccountOwner,
        details: TaggedUnion([
            USBankAccount, IBANBankAccount, CABankAccount, GBBankAccount, OtherBankAccount
        ], {tag: "type"}),
        active: Type.Boolean({
            description: "Whether or not the Bank Account is active."
        }),
        created_at: Type.Number({
            description: "The date and time at which the object was created."
        }),
    }, {
        $id: 'BankAccount',
        description: "Bank account details."
    }
)

export type BankAccount = Static<typeof BankAccount>
export const CreateBankAccountRequest = Type.Object({
    ...Type.Omit(BankAccount, ['id', 'owner', 'created_at', 'active']).properties,
    owner: Type.Omit(BankAccountOwner, ['id'])
}, {
    $id: 'CreateBankAccountRequest',
    description: "Create new bank account request."
})
export type CreateBankAccountRequest = Static<typeof CreateBankAccountRequest>


const CCPayinSchema = Type.Object({
    type: Type.Literal("cc_payin"),
    card: Type.String()
})
const WirePayoutSchema = Type.Object({
    type: Type.Literal("wire_payout"),
    account: Type.String(),
    wire_ref: Type.String({maxLength: 12})
})
const WirePayinSchema = Type.Object({
    type: Type.Literal("wire_payin"),
})
export const CreateTransactionRequest = Type.Object({
    amount: AmountSchema,
    details: TaggedUnion([WirePayinSchema, CCPayinSchema, WirePayoutSchema], {tag: "type"})
})
export type CreateTransactionRequest = Static<typeof CreateTransactionRequest>