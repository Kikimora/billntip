import mangopay, {bankAccount, base, kycDocument} from "mangopay2-nodejs-sdk";
import _ from "lodash";
import {Static, Type} from "@sinclair/typebox";
import {intervalToDuration} from "date-fns";
import {Value} from "@sinclair/typebox/value";
import {toPascalCase} from "@app/util";
import {badRequestError, internalError, notFoundError, notImplementedError, map, Mapping} from "@app/lambda";
import {TraceAttributes} from "@app/diagnostics";
import {UserAttribute} from "@src/users/attributes";
import * as schemas from "./schemas";
import {KYCProcess} from "./schemas";

type RegisteredMemberItem = { walletId: string, mangopayUid: string }

export const MangopayOptions = Type.Object({
    clientId: Type.String(),
    clientApiKey: Type.String(),
    baseUrl: Type.String()
})

export type MangopayOptions = Static<typeof MangopayOptions>

export class MangopayAPI {
    private readonly api: mangopay

    constructor(options: MangopayOptions) {
        this.api = new mangopay(options)
    }

    async createUser(username: string, userAttributes: UserAttribute[]) {
        const {api} = this
        const mangoPayUser = this.createUserRequest(userAttributes, username);
        const response = await api.Users.create(mangoPayUser).catch(function (e) {
            throw mangopayError(e, "createUser", {mangoPayUser, username, userAttributes})
        })
        return response.Id
    }

    async updateUser(mangopayUid: string, username: string, userAttributes: UserAttribute[]) {
        const {api} = this
        const mangoPayUser = this.createUserRequest(userAttributes, username);
        const request = {...mangoPayUser, Id: mangopayUid};
        const response = await api.Users.update(request).catch(function (e) {
            throw mangopayError(e, "createUser", {mangoPayUser, username, userAttributes})
        })
        return response.Id
    }

    private createUserRequest(userAttributes: UserAttribute[], username: string) {
        const attributes = _(userAttributes).keyBy('name').mapValues('value').value()
        const {
            email,
            first_name,
            last_name,
            phone: phone,
            birthdate: birthdateStr,
            address: addressJSON,
            nationality: nationality,
            tos: tosJSON
        } = attributes
        const address = JSON.parse(addressJSON ?? "{}")
        const tos = JSON.parse(tosJSON ?? "{}")
        const birthdate = Date.parse(birthdateStr) / 1000
        const interval = intervalToDuration({
            start: birthdate,
            end: new Date(),
        })
        const age = (interval.years ?? 0) + 1
        const userDetails = {
            first_name, last_name, phone, birthdate: age, address, nationality, tos
        };
        const recipient = Value.Decode(schemas.Recipient, userDetails)

        const mangoPayUser: mangopay.user.CreateUserNaturalOwnerData = {
            PersonType: "NATURAL",
            FirstName: recipient.first_name,
            LastName: recipient.last_name,
            Email: email ?? (username.indexOf('@') >= 0 ? username : `${username}@billntip.com`),
            Birthday: birthdate,
            Nationality: recipient.nationality.toUpperCase() as any,
            CountryOfResidence: recipient.address.country.toUpperCase() as any,
            TermsAndConditionsAccepted: true,
            Address: {
                AddressLine1: recipient.address.street_address ?? "",
                AddressLine2: "",
                City: recipient.address.locality ?? "",
                Region: recipient.address.region ?? "",
                PostalCode: recipient.address.postal_code ?? "",
                Country: recipient.address.country.toUpperCase() as any
            },
            Tag: username,
            UserCategory: "OWNER",
        }
        return mangoPayUser;
    }

    async createWallet(mangopayUid: string) {
        const {api} = this
        const request: mangopay.wallet.CreateWallet = {
            Currency: "EUR",
            Description: "Bill&Tip recipient wallet.",
            Owners: [mangopayUid],
            Tag: "Recipient"
        }
        const response = await api.Wallets.create(request).catch(function (e) {
            throw mangopayError(e, "createWallet", {request})
        })
        return response.Id
    }

    async fetchKYCDocument(rid: string) {
        const {api} = this
        const doc = await api.KycDocuments.get(rid).catch(function (e) {
            throw mangopayError(e, "fetchKYCDocument", {rid})
        })
        return toKycProcess(doc)
    }
}

export default class MangopayUser {
    public readonly api: mangopay

    constructor(options: MangopayOptions,
                public readonly username: string,
                private readonly member: RegisteredMemberItem) {
        this.api = new mangopay(options)
    }

    get uid() {
        return this.member.mangopayUid
    }

    get walletId() {
        return this.member.walletId
    }

    async createEmptyCard(request: schemas.NewEmptyCardRequest): Promise<schemas.EmptyCard> {
        const {member, username, api} = this
        const card = await api.CardRegistrations.create({
            UserId: this.member.mangopayUid,
            Currency: request.currency as any,
            CardType: request.type,
            Tag: this.username
        }).catch(function (e) {
            throw mangopayError(e, "createEmptyCard", {request, member, username})
        })
        if (card.Status !== 'CREATED') {
            throw internalError("Unexpected error creating card").withContext("createEmptyCard", {
                request,
                member,
                username,
                card
            })
        }
        return {
            id: card.Id,
            type: card.CardType,
            currency: card.Currency,
            tokenization: {
                access_key: card.AccessKey,
                data: card.RegistrationData,
                id: card.CardRegistrationURL
            }
        }
    }

    async updateCard(request: schemas.UpdateCardRequest): Promise<schemas.Card> {
        const {member, username, api} = this
        const card = await api.CardRegistrations.update({
            Id: request.id,
            RegistrationData: request.token,
            CardHolderName: request.cardholder_name
        }).catch(function (e) {
            throw mangopayError(e, "createEmptyCard", {request, member, username})
        })
        if (card.Status !== 'VALIDATED') {
            throw internalError("Unexpected error creating card").withContext("updateCard", {
                request,
                member,
                username,
                card
            })
        }
        return {
            id: card.Id,
            currency: card.Currency,
            type: card.CardType
        }
    }

    async fetchWallet(): Promise<schemas.Wallet> {
        const {member, api} = this
        const {walletId} = member
        const response = await api.Wallets.get(walletId).catch(function (e) {
            throw mangopayError(e, "fetchWallet", {member})
        })
        const pendingPayouts = await api.Wallets.getTransactions(walletId, {
            parameters: {
                Status: "CREATED",
                Type: "PAYOUT"
            }
        })
        const pending = pendingPayouts.reduce(function (acc, p) {
            return acc + p.DebitedFunds.Amount
        }, 0)
        return {
            id: this.username,
            created_at: response.CreationDate,
            description: response.Description,
            amount: response.Balance.Amount,
            currency: response.Balance.Currency,
            pending: pending
        }
    }

    async fetchUserInfo() {
        const {member, api} = this
        const response = await api.Users.get(member.mangopayUid).catch(function (e) {
            throw mangopayError(e, "fetchUser", {member})
        }) as mangopay.models.UserNatural
        return {
            id: this.username,
            created_at: response.CreationDate,
            kycLevel: response.KYCLevel,
            category: response.UserCategory,
            proofOfIdentity: response.ProofOfIdentity !== null ? response.ProofOfIdentity : undefined,
            proofOfAddress: response.ProofOfAddress !== null ? response.ProofOfAddress : undefined,
        }
    }

    async fetchRegulatoryStatus() {
        const {member, api} = this
        const users = api.Users as unknown as RegulatoryDataProvider;
        const response = await users.getRegulatory(member.mangopayUid).catch(function (e) {
            throw mangopayError(e, "fetchRegulatoryStatus", {member})
        })
        return {
            action_code: response.ActionCode,
            blocked: {
                inflows: response.ScopeBlocked.Inflows,
                outflows: response.ScopeBlocked.Outflows,
            }
        }
    }

    async transactions(query: schemas.TransactionsQuery) {
        const {member, api} = this
        const request = {parameters: toQuery(query),};
        console.log(request)
        const response = await api.Wallets.getTransactions(member.walletId, request).catch(function (e) {
            throw mangopayError(e, "transactions", {member, request})
        })
        return response.map(fromTransaction)
    }

    async fetchTransaction(id: string) {
        const {member, api} = this

        function fetch(id: string) {
            if (id.startsWith("po_m")) {
                return api.PayOuts.get(id)
            } else if (id.startsWith("payin_m")) {
                return api.PayIns.get(id)
            } else if (id.startsWith("xfer_m")) {
                return api.Transfers.get(id)
            } else {
                throw badRequestError("Unexpected transaction id type").withContext("fetchTransaction", {member, id})
            }
        }

        const response = await fetch(id).catch(function (e) {
            throw mangopayError(e, "fetchTransaction", {member, id})
        })

        if (response.AuthorId !== member.mangopayUid && response.CreditedUserId !== member.mangopayUid)
            throw notFoundError()

        return fromTransaction(response)
    }

    async startVerification({files, type}: schemas.VerificationRequest): Promise<schemas.VerificationResponse> {
        const {member, api} = this
        const {mangopayUid} = member

        const details = await this.fetchVerificationDetails()
        if (details[type]?.status === 'VALIDATION_ASKED') {
            throw badRequestError("Verification already in progress")
                .withContext("startVerification", {type, member, details})
        }

        const kycDocType = toDocumentType(type)
        let doc = await api.Users.createKycDocument(mangopayUid, {Type: kycDocType}).catch(function e() {
            throw mangopayError(e, "createKycDocument", {member})
        })

        const uploads = files.map(function (page) {
            return api.Users.createKycPage(mangopayUid, doc.Id, {File: page}).catch(function (e) {
                throw mangopayError(e, "createKycPage", {doc, page, member})
            })
        })
        await Promise.all(uploads)

        const updateDocRequest = {
            Id: doc.Id,
            Status: "VALIDATION_ASKED"
        } as const;
        doc = await api.Users.updateKycDocument(mangopayUid, updateDocRequest).catch(function (e) {
            throw mangopayError(e, "updateKycDocument", {doc, updateDocRequest, member})
        })

        return {
            type: type,
            data: toKycProcess(doc)
        }
    }

    async fetchVerificationDetails(): Promise<schemas.KYCDetails> {
        const {member, api} = this
        const {mangopayUid} = member

        const docs = await api.Users.getKycDocuments(mangopayUid).catch(function (e) {
            throw mangopayError(e, "fetchVerificationStatus", {member})
        })

        function docOrder(doc: kycDocument.KycDocumentData) {
            switch (doc.Status) {
                case 'VALIDATION_ASKED':
                    return 0
                case 'VALIDATED':
                    return 1
                case 'OUT_OF_DATE':
                case 'REFUSED':
                    return 2
                case 'CREATED':
                    return 3
            }
        }

        const details: schemas.KYCDetails = {}
        const groups = _.groupBy(docs, 'Type')
        for (const [type, docs] of Object.entries(groups)) {
            docs.sort(function (x, y) {
                //sort by doc status
                const order = docOrder(x) - docOrder(y)
                if (order != 0) return order
                //then by creation date
                return y.CreationDate - x.CreationDate
            })
            const [mostRecent] = docs
            if (docs.length > 0) {
                switch (type) {
                    case "IDENTITY_PROOF":
                        details.identity = toKycProcess(mostRecent)
                        break
                    case "REGISTRATION_PROOF":
                        details.registration = toKycProcess(mostRecent)
                        break
                    case "ARTICLES_OF_ASSOCIATION":
                        details.articles_of_association = toKycProcess(mostRecent)
                        break
                    case "SHAREHOLDER_DECLARATION":
                        details.shareholder_declaration = toKycProcess(mostRecent)
                        break
                    case "ADDRESS_PROOF":
                        details.address = toKycProcess(mostRecent)
                        break
                }
            }
        }
        return details
    }

    async fetchBankAccounts(query: schemas.BankAccountsQuery): Promise<schemas.BankAccount[]> {
        const {member, api} = this
        const {mangopayUid} = member

        const request = {parameters: toQuery(query),};
        const accounts = await api.Users.getBankAccounts(mangopayUid, request).catch(function (e) {
            throw mangopayError(e, "fetchBankAccounts", {member, query}, bankAccountMapper.mapping)
        })
        return accounts.map(x => bankAccountMapper.mapDirect(x) as schemas.BankAccount)
    }

    async fetchBankAccount(bankAccountId: string): Promise<schemas.BankAccount> {
        const {member, api} = this
        const {mangopayUid} = member

        const account = await api.Users.getBankAccount(mangopayUid, bankAccountId).catch(function (e) {
            throw mangopayError(e, "fetchBankAccount", {member, bankAccountId}, bankAccountMapper.mapping)
        })
        return bankAccountMapper.mapDirect(account) as schemas.BankAccount
    }

    async deactivateBankAccount(bankAccountId: string): Promise<schemas.BankAccount> {
        const {member, api} = this
        const {mangopayUid} = member
        const account = await api.Users.deactivateBankAccount(mangopayUid, bankAccountId).catch(function (e) {
            throw mangopayError(e, "deactivateBankAccount", {member, bankAccountId}, bankAccountMapper.mapping)
        })
        return bankAccountMapper.mapDirect(account) as schemas.BankAccount
    }

    async createBankAccount(body: schemas.CreateBankAccountRequest): Promise<schemas.BankAccount> {
        const {member, api} = this
        const {mangopayUid} = member
        const mangoPayRequest = bankAccountRequestMapper.mapInverse(body);
        const account = await api.Users.createBankAccount(mangopayUid, mangoPayRequest as any).catch(function (e) {
            throw mangopayError(e, "createBankAccount", {
                member,
                mangoPayRequest
            }, bankAccountRequestMapper.mapping)
        })
        return bankAccountMapper.mapDirect(account) as schemas.BankAccount
    }

    async createTransaction(request: schemas.CreateTransactionRequest): Promise<schemas.Transaction> {
        const {member, api, username} = this
        const {mangopayUid, walletId} = member
        switch (request.details.type) {
            case 'wire_payout': {
                const mangoPayRequest = {
                    ...payoutMapper.mapInverse(request),
                    PaymentType: "BANK_WIRE",
                    AuthorId: mangopayUid,
                    Fees: {
                        Currency: "EUR",
                        Amount: 1
                    },
                    DebitedWalletId: walletId,
                    PayoutModeRequested: "STANDARD",
                    Tag: username
                } as mangopay.payOut.CreatePayOut
                const response = await api.PayOuts.create(mangoPayRequest).catch(function (e) {
                    throw mangopayError(e, "createTransaction", {
                        mangopayUid,
                        mangoPayRequest
                    }, bankAccountRequestMapper.mapping)
                })
                return fromTransaction(response)
            }
            default:
                throw notImplementedError()
        }
    }
}


function toKycProcess(doc: kycDocument.KycDocumentData): KYCProcess {
    return {
        type: fromDocumentType(doc.Type),
        process_id: doc.Id,
        created_at: doc.CreationDate,
        processed_at: doc.ProcessedDate,
        status: doc.Status,
        refuse_reason: doc.RefusedReasonType,
        refuse_message: doc.RefusedReasonMessage,
        tag: doc.Tag
    }
}

/**
 * Convert mangoPay error into common API format and map MangoPay fields mentioned in the error into API data model.
 */
function mangopayError(e: any, name: string, attributes: TraceAttributes, mapping?: Mapping) {
    const value = {
        ...attributes,
        message: e.Message ?? "Unexpected error.",
        errors: e.errors ?? {},
        type: e.TDynamoAttribute ?? "",
        id: e.Id
    }

    if (value.type === 'param_error') {
        let [path, message] = Object.entries(value.errors)[0]
        const failedPath = path.split('.')
        const failedPropMapping = _.find(mapping, function (mapping) {
            const [mangoPayPath] = mapping
            //So far I discovered following situations:
            //'DebitedFunds.Currency' - referring to DebitedFunds:{ Currency }
            const isPerfectMatch = _.isEqual(mangoPayPath, failedPath)
            if (isPerfectMatch) return true
            //'DebitedFunds.Currency' - referring to DebitedFunds:{ Currency }
            const isMoneyAmount = mangoPayPath[0] === failedPath[0] && mangoPayPath[1] === 'Amount'
            if (isMoneyAmount) return true
            //'PostalCode' - referring to OwnerAddress:{ PostalCode }
            return failedPath.length === 1 && mangoPayPath[mangoPayPath.length - 1] === failedPath[0];
        })

        if (failedPropMapping !== undefined) {
            const [_, apiPath] = failedPropMapping
            path = '/' + apiPath.join('/')
        }

        return badRequestError(message ?? value.message, {path}).withContext({name, value})
    }

    if (value.type === 'ressource_not_found' || value.type === 'resource_not_found') {
        throw notFoundError()
    }

    return internalError(value.message, value.errors).withContext({name, value});
}

interface RegulatoryData {
    Id: string
    ActionCode: string
    ScopeBlocked: {
        Inflows: boolean
        Outflows: boolean
    }
}

interface RegulatoryDataProvider {
    getRegulatory: base.MethodOverload<string, RegulatoryData>;
}

const bankAccountRequestMapping: Mapping<bankAccount.CreationDetails, schemas.CreateBankAccountRequest> = [
    [['OwnerName'], ['owner', 'name']],
    [['OwnerAddress', 'AddressLine1'], ['owner', 'address_line1']],
    [['OwnerAddress', 'AddressLine2'], ['owner', 'address_line2']],
    [['OwnerAddress', 'PostalCode'], ['owner', 'zip']],
    [['OwnerAddress', 'City'], ['owner', 'city']],
    [['OwnerAddress', 'Country'], ['owner', 'country']],
    [['OwnerAddress', 'Region'], ['owner', 'region']],

    [['Type'], ['details', 'type']],
    [['IBAN'], ['details', 'iban']],
    [['AccountNumber'], ['details', 'account_number']],
    [['BIC'], ['details', 'bic']],
    [['BankName'], ['details', 'bank_name']],
    [['ABA'], ['details', 'aba']],
    [['InstitutionNumber'], ['details', 'institution_number']],
    [['BranchCode'], ['details', 'branch_code']],
    [['SortCode'], ['details', 'sort_code']],
    [['DepositAccountType'], ['details', 'deposit_type']],
    [['Country'], ['details', 'country']],
]

const bankAccountMapping: Mapping<bankAccount.Data, schemas.BankAccount> = [
    [['Id'], ['id']],
    [['Active'], ['active']],
    [['CreationDate'], ['created_at']],
    ...bankAccountRequestMapping
]
const bankAccountMapper = map.object(bankAccountMapping)
const bankAccountRequestMapper = map.object(bankAccountRequestMapping)

const payoutMapping: Mapping<mangopay.payOut.CreatePayOut, schemas.CreateTransactionRequest> = [
    [['DebitedFunds', 'Amount'], ['amount', 'amount']],
    [['DebitedFunds', 'Currency'], ['amount', 'currency']],
    [['BankAccountId'], ['details', 'account']],
    [['BankWireRef'], ['details', 'wire_ref']],
]
const payoutMapper = map.object(payoutMapping)

/**
 * Generic utility to map queries to MangoPay queries.
 */
function toQuery(query: Record<string, string | number | boolean>): (mangopay.base.FilterOptions & mangopay.base.PaginationOptions) {
    return _(query)
        .mapKeys(function (value, key) {
            switch (key) {
                case 'before':
                    return 'BeforeDate'
                case 'after':
                    return 'AfterDate'
                case 'per_page':
                    return 'Per_Page'
                default:
                    return toPascalCase(key)
            }
        })
        .mapValues(function (value, key) {
            switch (key) {
                case 'Sort':
                    if (typeof value === 'string') {
                        let [column, dir] = value.split(':')
                        switch (column) {
                            case 'created_at':
                                column = 'CreationDate';
                                break;
                        }
                        return `${toPascalCase(column)}:${dir}`
                    }
                    return value
                default:
                    return value
            }
        })
        .value()
}

function parseTag(tag: string) {
    try {
        return JSON.parse(tag) as { org?: string, loc?: string }
    } catch (e) {
        return {}
    }
}

function fromTransaction(tx: mangopay.transaction.TransactionData) {
    const info = parseTag(tx.Tag)
    return {
        id: tx.Id,
        credit: {amount: tx.CreditedFunds.Amount, currency: tx.CreditedFunds.Currency},
        debit: {amount: tx.DebitedFunds.Amount, currency: tx.DebitedFunds.Currency},
        ...info,
        type: tx.Type,
        execution_date: tx.ExecutionDate,
        created_at: tx.CreationDate,
        fee: {amount: tx.Fees.Amount, currency: tx.Fees.Currency},
        result_code: tx.ResultCode,
        result_message: tx.ResultMessage,
        status: tx.Status
    }
}

function toDocumentType(docType: schemas.KYCDocumentType): kycDocument.KycDocumentType {
    switch (docType) {
        case 'address':
            return 'ADDRESS_PROOF'
        case 'identity':
            return 'IDENTITY_PROOF'
        case 'articles_of_association':
            return 'ARTICLES_OF_ASSOCIATION'
        case 'registration':
            return 'REGISTRATION_PROOF'
        case 'shareholder_declaration':
            return 'SHAREHOLDER_DECLARATION'
        default:
            throw badRequestError("Invalid document type").withContext("toDocumentType", {docType})
    }
}

function fromDocumentType(docType: kycDocument.KycDocumentType): schemas.KYCDocumentType {
    switch (docType) {
        case 'ADDRESS_PROOF':
            return 'address'
        case 'IDENTITY_PROOF':
            return 'identity'
        case 'ARTICLES_OF_ASSOCIATION':
            return 'articles_of_association'
        case 'REGISTRATION_PROOF':
            return 'registration'
        case 'SHAREHOLDER_DECLARATION':
            return 'shareholder_declaration'
        default:
            throw badRequestError("Invalid document type").withContext("toDocumentType", {docType})
    }
}
