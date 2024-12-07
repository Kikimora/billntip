import {Static, TObject, Type as T, Type} from "@sinclair/typebox";
import {TaggedUnion} from "@app/lambda/tagged_union";
import {DDB, registerDefaultFormats} from "@app/lambda";

registerDefaultFormats()
export const OrgId = Type.String({
    description: "Organisation id",
    minLength: 3,
    maxLength: 36
})

export const UserId = Type.String({
    maxLength: 36,
    minLength: 20,
    description: "User id"
})

export const LocationId = Type.String({
    description: "Location id",
    minLength: 20,
    maxLength: 36
});

const ShortUserInfo = Type.Object({
    id: Type.String({description: "Unique user identifier"}),
    email: Type.Optional(Type.String({description: "User email"})),
    profile_pic: Type.Optional(Type.String({description: "User profile picture"})),
    first_name: Type.Optional(Type.String({description: "User first name"})),
    last_name: Type.Optional(Type.String({description: "User last name"})),
});

export const PublicOrgInfo = Type.Object({
        id: OrgId,
        title: Type.String({description: "Organisation name"})
    }, {
        $id: "Organisation",
        description: "Target organisation"
    }
);
export type PublicOrgInfo = Static<typeof PublicOrgInfo>

const BasicOrganisationInfo = Type.Object({
        id: Type.String({description: "Organisation identifier"}),
        title: Type.String({description: "Organisation name"})
    }, {
        $id: "BasicOrganisationInfo",
        description: "Basic information about an organisation"
    }
);
export const MemberRole = Type.Union([
    Type.Literal("admin"),
    Type.Literal("member")
], {$id: "MemberRole", description: "Member role in the organisation"});
export type MemberRole = Static<typeof MemberRole>

export const MembersQuery = {
    from: Type.Optional(Type.String()),
    location: Type.Optional(Type.String()),
}

export type MembersQuery = Static<TObject<typeof MembersQuery>>

export const MemberSchema = Type.Object({
    id: Type.String(),
    accepted_at: Type.Optional(Type.Number({
        description: "Invite acceptance timestamp", examples: [1716814592]
    })),
    invited_at: Type.Number({
        description: "Invite creation timestamp", examples: [1716814592]
    }),
    invited_by: Type.Optional(ShortUserInfo),
    user: Type.Optional(ShortUserInfo),
    org: BasicOrganisationInfo,
    rejected_at: Type.Optional(Type.Number({description: "Rejection timestamp", examples: [1716814592]})),
    role: MemberRole
}, {$id: "MemberSchema", description: "Organisation member"})

export type Member = Static<typeof MemberSchema>

const Amount = Type.Number({
    $id: "Amount",
    description: 'An amount of money in the smallest sub-division of the currency (e.g., EUR 12.60 would be represented as 1260 whereas JPY 12 would be represented as just 12).',
    examples: [10]
})
const Currency = Type.String({
    $id: "Currency",
    description: "Currency in the ISO_4217 format",
    examples: ["EUR"]
})

const AmountSchema = Type.Object({
    amount: Amount,
    currency: Currency,
}, {$id: "AmountSchema"})

export const TxType = T.Union([T.Literal("PAYIN"), T.Literal("TRANSFER"), T.Literal("CONVERSION"), T.Literal("PAYOUT"), T.Literal("CARD_VALIDATION")], {$id: "TxType"});
export const TxStatus = T.Union([T.Literal("CREATED"), T.Literal("SUCCEEDED"), T.Literal("FAILED")], {$id: "TxStatus"});

export const WalletBalance = Type.Object({
    amount: Amount,
    pending: Amount,
    currency: Currency,
}, {$id: "WalletBalance"})
export type WalletBalance = Static<typeof WalletBalance>

export const Wallet = Type.Object({
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
    ...WalletBalance.properties
}, {
    $id: "Wallet",
    description: "The digital e-wallet on which funds are stored."
})
export type Wallet = Static<typeof Wallet>

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
    auth: Type.Optional(Type.Object({
        redirect_url: Type.Optional(Type.String({format: "uri"})),
        return_url: Type.Optional(Type.String({format: "uri"})),
    })),
    details: Type.Record(Type.String(), Type.String())
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

export const TxId = {
    id: T.String({
        description: "Transaction identifier",
        examples: ["po_m_01J31CGYNP3NBXGVQJF7DBA7QT", "xfer_m_01J30D359GWGMYN12YFJJH03YP", "payin_m_01J30C0NDB6CSBYF4GZXFK1B5N"]
    })
}

const KYCDocumentType = Type.Union([
    Type.Literal("address"),
    Type.Literal("identity"),
    Type.Literal("registration"),
    Type.Literal("articles_of_association"),
    Type.Literal("shareholder_declaration")]);
export const KYCProcess = Type.Object({
    process_id: Type.String({description: "Verification process identifier."}),
    type: KYCDocumentType,
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
    refuse_reason: Type.Optional(Type.Union([
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
    ])),
    refuse_message: Type.Optional(Type.String({description: "Message from the KYC team explaining reason for refusal."})),
    tag: Type.Optional(Type.String())
}, {
    $id: "KYCProcess",
    description: "The KYC Process object is a container tracking KYC document submissions, verification process and outcome."
});
export type KYCProcess = Static<typeof KYCProcess>
export const KYCDetails = Type.Object({
    address: Type.Optional(KYCProcess),
    identity: Type.Optional(KYCProcess),
    registration: Type.Optional(KYCProcess),
    articles_of_association: Type.Optional(KYCProcess),
    shareholder_declaration: Type.Optional(KYCProcess),
}, {$id: "KYCDetails"})
export type KYCDetails = Static<typeof KYCDetails>
const VerificationFiles = Type.Array(Type.String({maxLength: 5 * 1024 * 1024}), {
    minItems: 1,
    maxItems: 2,
    $id: "VerificationFiles"
})
export type KYCDocumentType = Static<typeof KYCDocumentType>
export const VerificationRequest = Type.Object({
    type: KYCDocumentType,
    files: VerificationFiles

}, {$id: "VerificationRequest"})
export type VerificationRequest = Static<typeof VerificationRequest>
export const VerificationResponse = Type.Object({
    type: KYCDocumentType,
    data: KYCProcess

}, {$id: "VerificationResponse"})
export type VerificationResponse = Static<typeof VerificationResponse>

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

const BrowserInfo = Type.Object({
    accept_header: Type.String(),
    java: Type.Boolean(),
    language: Type.String(),
    color_depth: Type.Number(),
    screen_height: Type.Number(),
    screen_width: Type.Number(),
    tz: Type.Number(),
    user_agent: Type.String(),
    js: Type.Boolean()
});
const PayInOptions = {
    auth_return_url: Type.String({format: "uri"}),
    browser_info: BrowserInfo,
    ip_address: Type.String()
}
const CCPayinSchema = Type.Object({
    type: Type.Literal("cc_payin"),
    card: Type.String(),
    ...PayInOptions
})
const WirePayoutSchema = Type.Object({
    type: Type.Literal("wire_payout"),
    account: Type.String({description: "The unique identifier of the bank account."}),
    wire_ref: Type.Optional(Type.String({
        maxLength: 255,
        description: "Custom description to appear on the user’s bank statement along with the platform name. Banks generally truncate the length, but to different extents depending on the bank. While max length is 255 less than 12 characters is recommended."
    })),
}, {$id: "WirePayoutSchema"})
const WirePayinSchema = Type.Object({
    type: Type.Literal("wire_payin"),
})
const GooglePayinSchema = Type.Object({
    type: Type.Literal("google_payin"),
    data: Type.String({maxLength: 4096}),
    ...PayInOptions
})

export const CreateTransactionRequest = Type.Object({
    amount: Amount,
    currency: Currency,
    details: TaggedUnion([WirePayinSchema, CCPayinSchema, WirePayoutSchema, GooglePayinSchema], {tag: "type"}),

})
export type CreateTransactionRequest = Static<typeof CreateTransactionRequest>

export const Me = Type.Object({
    kyc: Type.Object({
        level: Type.Union([Type.Literal("LIGHT"), Type.Literal("REGULAR")]),
        evidence: KYCDetails
    }),
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
    wallet: Type.Optional(WalletBalance)
}, {$id: "Me"})

export const Recipient = Type.Object({
    first_name: Type.String({minLength: 3, maxLength: 100}),
    last_name: Type.String({minLength: 3, maxLength: 100}),
    phone: Type.String({minLength: 3, pattern: "\\+\\d+", maxLength: 100}),
    birthdate: Type.Number({minimum: 18, maximum: 200}),
    address: Type.Object({
        country: Type.String({minLength: 2, maxLength: 3}),
        street_address: Type.Optional(Type.String()),
        locality: Type.Optional(Type.String()),
        region: Type.Optional(Type.String()),
        postal_code: Type.Optional(Type.String()),
    }),
    nationality: Type.String({minLength: 2, maxLength: 3}),
    tos: Type.Object({
        general: Type.Literal(true),
        privacy: Type.Literal(true),
    })
})
export type Recipient = Static<typeof Recipient>
export const Image = Type.Object({
    id: Type.String({
        description: "Image identifier",
        maxLength: 1024,
        examples: ["my-org/my-loc/9a0c44a5-37b9-4eac-a2c3-63cc50528a53.png"]
    }),
    version: Type.Optional(Type.Number())
}, {$id: "Image"})
export type Image = Static<typeof Image>
export const Goal = DDB.Item({
    target: Type.Number({
        minimum: 0,
        description: "Target amount",
        examples: [500]
    }),
    description: Type.String({
        maxLength: 1000,
        description: "Goal description",
        examples: ["Red Ferrari"]
    }),
    total: Type.Number({
        minimum: 0,
        description: "Amount collected so far",
        examples: [10]
    })
}, {$id: "Location or individual goal"})
export const LocationRequest = Type.Object({
    title: Type.String({maxLength: 200}),
    email: Type.Optional(Type.String({maxLength: 100})),
    phone: Type.Optional(Type.String({maxLength: 16})),
    address: Type.Optional(Type.String({maxLength: 1000})),
    goal: Type.Optional(Type.Omit(Goal, ['total'])),
    image: Type.Optional(Image),
}, {$id: "LocationRequest"})
export type LocationRequest = Static<typeof LocationRequest>

export const Location = Type.Object({
    id: Type.String({
        description: "Location id"
    }),
    org_id: Type.String({
        description: "Parent organisation id"
    }),
    title: Type.String({
        description: "Location title",
        examples: ["KFC at Baker's Street"]
    }),
    email: Type.Optional(Type.String({
        description: "Location email",
        examples: ["restaurant@example.com"]
    })),
    address: Type.Optional(Type.String({
        description: "Location address",
        examples: ["Rus dos Alamos, 100, 2drt, 2705-346, Lisbon, Portugal"]
    })),
    goal: Type.Optional(Goal),
    phone: Type.Optional(Type.String({
        description: "Location phone",
        examples: ["+351 123 456 789"]
    })),
    created_at: Type.Number({
        description: "The date and time at which the object was created",
        examples: [1716814592]
    }),
    updated_at: Type.Number({
        description: "The date and time at which the object was updated",
        examples: [1716814592]
    }),
    image_url: Type.Optional(Type.String({
        format: "uri",
        description: "Location image url",
        maxLength: 1024,
        examples: ["https://static.billntip.com/public/my-org/my-loc/9a0c44a5-37b9-4eac-a2c3-63cc50528a53.png"]
    })),
    image: Type.Optional(Image),
    archived: Type.Optional(Type.Boolean({
        description: "Indicates whenever location is archived or not",
        default: false
    }))
}, {$id: "Location"})
export type Location = Static<typeof Location>
export const LocationInfo = Type.Pick(Location, ['id', 'title', 'image', 'address', 'email', 'phone', 'goal'], {$id: "LocationInfo"})
export type LocationInfo = Static<typeof LocationInfo>
export const LocationsQuery = {
    start_key: Type.Optional(Type.String({
        description: "Start searching locations from this key"
    })),
    archived: Type.Optional(Type.Boolean({
        default: false,
        description: "Include archived locations into the response"
    })),
    title: Type.Optional(Type.String({
        description: "Filter location by title"
    }))
}
export type LocationsQuery = Static<TObject<typeof LocationsQuery>>

export const CardType = Type.Union([
    Type.Literal("CB_VISA_MASTERCARD"),
    Type.Literal("DINERS"),
    Type.Literal("MASTERPASS"),
    Type.Literal("MAESTRO"),
    Type.Literal("P24"),
    Type.Literal("IDEAL"),
    Type.Literal("BCMC"),
    Type.Literal("PAYLIB")
], {$id: "CardType"})
export type CardType = Static<typeof CardType>
export const Card = Type.Object({
    id: Type.String({maxLength: 40}),
    type: CardType,
    currency: Type.String({maxLength: 3}),
    alias: Type.String(),
    provider: Type.String(),
    bank_code: Type.String(),
    country: Type.String(),
    fingerprint: Type.String(),
    exp: Type.String(),
    created_at: Type.Number(),
}, {$id: "Card"})
export type Card = Static<typeof Card>
export const CardRegistration = Type.Object({
    id: Type.String({maxLength: 40}),
    type: CardType,
    currency: Type.String({maxLength: 3}),
    tokenization: Type.Object({
        id: Type.String(),
        access_key: Type.String(),
        data: Type.String()
    })
}, {$id: "CardRegistration"})
export type CardRegistration = Static<typeof CardRegistration>
export const NewEmptyCardRequest = Type.Omit(CardRegistration, ['id', 'tokenization'])
export type NewEmptyCardRequest = Static<typeof NewEmptyCardRequest>
export const UpdateCardRequest = Type.Object({
    id: Type.String({maxLength: 40}),
    cardholder_name: Type.Optional(Type.String({maxLength: 120})),
    token: Type.String(),
}, {$id: "UpdateCardRequest"})
export type UpdateCardRequest = Static<typeof UpdateCardRequest>

export const TipRecipient = TaggedUnion([
    Type.Object({
        type: Type.Literal("person"),
        id: Type.String(),
        first_name: Type.String(),
        last_name: Type.String(),
        image: Image,
        goal: Type.Optional(Goal)
    }),
    Type.Object({type: Type.Literal("team"), id: Type.String(), name: Type.String(), logo: Image}),
    Type.Object({type: Type.Literal("location"), id: Type.String(), name: Type.String(), logo: Image}),
], {
    tag: "type",
    $id: "TipRecipient",
    description: "Describes a tip recipient."
})

//target: { [key in "me" | "my team" | string]: number }
//allocation: "equal", "hourly"
//schedule: "string", used only if allocation is 'equal'

//target: { me: number, my_team: number, teams: {}, individuals: {} }

//1.1 target: {"my_team":100}, allocation: "equal", schedule: "2 weeks"
//1.2 target: {"my_team":100}, allocation: "hourly"
//1.3 target: {teams: {"waiters": 60, "kitchen":30, cleaning: 10 }}, allocation: "equal" , schedule: "2 weeks"
//1.4 target: {teams: {"waiters": 60, "kitchen":30, cleaning: 10 }}, allocation: "hourly"
//2.1 target: {"me": 100}, allocation: "equal", schedule: "2 weeks"
//2.2 target: {"me": 60, teams: {"kitchen":30}, individuals: {"mike owner": 10} }, allocation:"equal", schedule: "2 weeks"

const TipDistribution = TaggedUnion([
    Type.Object({
        type: Type.Literal("common"),
    }),
    Type.Object({
        type: Type.Literal("individual"),
        allocation: Type.Array(Type.Object({
            type: Type.Union([Type.Literal("team"), Type.Literal("individual")]),
            id: Type.Union([Type.Literal("recipient"), Type.String()]),
            value: Type.Number({maximum: 1, minimum: 0}),
        }))
    })
], {tag: "type"})

const TipType = Type.Union([Type.Literal("common"), Type.Literal("individual")]);
export const TipSettings = Type.Object({
    organization: PublicOrgInfo,
    location: LocationInfo,
    recipient: TipRecipient,
    currency: Currency,
    tips: Type.Array(Amount, {description: "Array of suggested tip amounts"}),
    feedback: Type.Object({
        questions: Type.Array(Type.String()),
        comment: Type.Boolean()
    }, {description: "Describes feedback options"}),
    payment_methods: Type.Array(CardType),
    type: TipType
}, {
    $id: "TipSettings"
})
export type TipType = Static<typeof TipType>
export type TipSettings = Static<typeof TipSettings>

export const TipRequest = Type.Object({
    payer: Type.String({maxLength: 40}),
    organization: OrgId,
    location: LocationId,
    recipient: Type.Object({
        type: Type.Union(TipRecipient.anyOf.map(x => x.properties.type), {description: "Tip recipient type"}),
        id: Type.String({description: "Tip recipient id"})
    }),
    feedback: Type.Object({
        answers: Type.Array(Type.Object({
            id: Type.String(),
            rating: Type.Number({description: "Rating from 1 to 5"})
        })),
        comment: Type.String({description: "Freeform comment to the staff", maxLength: 1000})
    }),
    amount: Amount,
    payment_method: Type.String({description: "Identifier of selected payment method"}),
    commission: Type.Union([Type.Literal("our"), Type.Literal("recipient")], {description: "Commission setting, defines who pays commission."}),
    tos: Type.Boolean({description: "Indicates whenever payee accepted Terms of Service"}),
    payment_auth_return_url: Type.String({format: "uri"}),
    browser_info: Type.Omit(BrowserInfo, ['accept_header']),
}, {$id: "TipRequest"})
export type TipRequest = Static<typeof TipRequest>

export const TipResponse = Type.Object({
    banner: Type.Object({
        image: Image,
        description: Type.String(),
        title: Type.String(),
        href: Type.String({format: "uri"})
    }),
    review_link: Type.Optional(Type.Object({
        type: Type.Union([Type.Literal("google_map"), Type.Literal("trip_advisor"), Type.Literal("link")]),
        href: Type.String({format: "uri"})
    })),
    need_review: Type.Boolean(),
    tx: Transaction
})
export type TipResponse = Static<typeof TipResponse>

export const TipSettingsQuery = {
    org: Type.String(),
    location: Type.String(),
    recipient: Type.Optional(Type.String())
}
export type TipSettingsQuery = Static<TObject<typeof TipSettingsQuery>>