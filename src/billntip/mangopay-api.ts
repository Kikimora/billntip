import _ from "lodash";
import {intervalToDuration} from "date-fns";
import {Static, Type} from "@sinclair/typebox";
import {Value} from "@sinclair/typebox/value";
import mangopay, {bankAccount, base, cardRegistration, kycDocument, payIn} from "mangopay2-nodejs-sdk";
import {badRequestError, internalError, map, Mapping, notFoundError, notImplementedError} from "@app/lambda";
import {UserAttributeItem as ProfileAttribute} from "@src/users/user";
import * as schemas from "./schemas";
import {TraceAttributes} from "@app/diagnostics";
import * as util from "@app/util";

export const MangopayOptions = Type.Object({
    clientId: Type.String(),
    clientApiKey: Type.String(),
    baseUrl: Type.String()
})

export type MangopayOptions = Static<typeof MangopayOptions>

export class MangopayAPI {
    private readonly api: mangopay

    constructor(private readonly options: MangopayOptions) {
        this.api = new mangopay(options)
    }

    async createUser(username: string, userAttributes: ProfileAttribute[]) {
        const {api} = this
        const mangoPayUser = this.createUserRequest(userAttributes, username);
        const response = await api.Users.create(mangoPayUser).catch(function (e) {
            throw mangopayError(e, "createUser", {mangoPayUser, username, userAttributes})
        })
        return response.Id
    }

    async updateUser(mangopayUid: string, username: string, userAttributes: ProfileAttribute[]) {
        const {api} = this
        const mangoPayUser = this.createUserRequest(userAttributes, username);
        const request = {...mangoPayUser, Id: mangopayUid};
        const response = await api.Users.update(request).catch(function (e) {
            throw mangopayError(e, "createUser", {mangoPayUser, username, userAttributes})
        })
        return response.Id
    }

    private createUserRequest(userAttributes: ProfileAttribute[], username: string) {
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
        const birthdate = Date.parse(birthdateStr ?? "") / 1000
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

    async createPayerUser() {
        const {api} = this
        const mangoPayUser = this.createPayerUserRequest();
        const response = await api.Users.create(mangoPayUser).catch(function (e) {
            throw mangopayError(e, "createPayerUser", {mangoPayUser})
        })
        return response.Id
    }

    private createPayerUserRequest() {
        const mangoPayUser: mangopay.user.CreateUserNaturalPayerData = {
            PersonType: "NATURAL",
            FirstName: "Payer",
            LastName: "User",
            Email: `${util.uuid.uuid()}@billntip.com`,
            Tag: "Payer",
            UserCategory: "PAYER",
        }
        return mangoPayUser;
    }

    async createWallet(mangopayUid: string, tag: string) {
        const {api} = this
        const request: mangopay.wallet.CreateWallet = {
            Currency: "EUR",
            Description: "Bill&Tip recipient wallet.",
            Owners: [mangopayUid],
            Tag: tag
        }
        const response = await api.Wallets.create(request).catch(function (e) {
            throw mangopayError(e, "createWallet", {request})
        })
        return response.Id
    }

    async fetchWallet(walletId: string) {
        const {api} = this
        return api.Wallets.get(walletId).catch(function (e) {
            throw mangopayError(e, "fetchWallet", {walletId})
        })
    }

    async getTransactions(walletId: string, options: base.MethodOptionWithoutResponse) {
        const {api} = this
        const response = await api.Wallets.getTransactions(walletId, options).catch(function (e) {
            throw mangopayError(e, "getTransactions", {walletId, options})
        })
        return response.map(fromTransaction)
    }

    async fetchTransaction(id: string, ownerId?: string) {
        const {api} = this

        function fetch(id: string) {
            if (id.startsWith("po_m")) {
                return api.PayOuts.get(id)
            } else if (id.startsWith("payin_m")) {
                return api.PayIns.get(id)
            } else if (id.startsWith("xfer_m")) {
                return api.Transfers.get(id)
            } else {
                throw internalError("Unexpected transaction id type").withContext("fetchTransaction", {id})
            }
        }

        const response = await fetch(id).catch(function (e) {
            throw mangopayError(e, "fetchTransaction", {id})
        })

        if (response.AuthorId !== ownerId && response.CreditedUserId !== ownerId)
            throw notFoundError()

        return fromTransaction(response)
    }

    async createTransaction(id: string, walletId: string, request: schemas.CreateTransactionRequest, tag?: string) {
        const {api} = this
        switch (request.details.type) {
            case 'wire_payout': {
                const mangoPayRequest = {
                    ...payoutMapper.mapInverse(request),
                    PaymentType: "BANK_WIRE",
                    AuthorId: id,
                    Fees: {
                        Currency: "EUR",
                        Amount: 1
                    },
                    DebitedWalletId: walletId,
                    PayoutModeRequested: "STANDARD",
                    Tag: tag
                } as mangopay.payOut.CreatePayOut
                const response = await api.PayOuts.create(mangoPayRequest).catch(function (e) {
                    throw mangopayError(e, "createPayout", {mangoPayRequest}, payoutMapper.mapping)
                })
                return fromTransaction(response)
            }
            case 'cc_payin': {
                const mangoPayRequest = {
                    ...cardPayinMapper.mapInverse(request),
                    ExecutionType: "DIRECT",
                    PaymentType: "CARD",
                    AuthorId: id,
                    CreditedWalletId: walletId,
                    DebitedFunds: {Amount: 10, Currency: "EUR"},
                    Fees: {Amount: 10, Currency: "EUR"},
                    SecureModeReturnURL: "",
                    Tag: tag
                } as mangopay.payIn.CreateCardDirectPayIn
                const response = await api.PayIns.create(mangoPayRequest).catch(function (e) {
                    throw mangopayError(e, "createPayout", {mangoPayRequest}, cardPayinMapper.mapping)
                })
                return fromTransaction(response)
            }
            default:
                throw notImplementedError()
        }
    }

    async fetchKYCDocument(rid: string) {
        const {api} = this
        const doc = await api.KycDocuments.get(rid).catch(function (e) {
            throw mangopayError(e, "fetchKYCDocument", {rid})
        })
        return toKycProcess(doc)
    }

    async createEmptyCard(request: cardRegistration.CreateCardRegistration) {
        const {api} = this
        return await api.CardRegistrations.create(request).catch(function (e) {
            throw mangopayError(e, "createEmptyCard", {request})
        })
    }

    async updateCard(request: cardRegistration.UpdateCardRegistration) {
        const {api} = this
        return await api.CardRegistrations.update(request).catch(function (e) {
            throw mangopayError(e, "updateCard", {request})
        })
    }

    async fetchCard(id: string) {
        const {api} = this
        return await api.Cards.get(id).catch(function (e) {
            throw mangopayError(e, "fetchCard", {id})
        })
    }

    async fetchUser(id: string) {
        const {api} = this
        return await api.Users.get(id).catch(function (e) {
            throw mangopayError(e, "fetchUser", {id})
        })
    }

    async fetchRegulatoryStatus(id: string) {
        const {api} = this
        const users = api.Users as unknown as RegulatoryDataProvider;
        return await users.getRegulatory(id).catch(function (e) {
            throw mangopayError(e, "fetchRegulatoryStatus", {id})
        })
    }

    async createKycDocument(id: string, type: schemas.KYCDocumentType) {
        const {api} = this
        const kycDocType = toDocumentType(type)
        const doc = await api.Users.createKycDocument(id, {Type: kycDocType}).catch(function e() {
            throw mangopayError(e, "createKycDocument", {id})
        })
        return toKycProcess(doc)
    }

    async createKycPage(id: string, docId: string, request: kycDocument.CreateKycPage) {
        const {api} = this
        return api.Users.createKycPage(id, docId, request).catch(function (e) {
            throw mangopayError(e, "createKycPage", {id, docId, request})
        })
    }

    async submitKycDocument(id: string, docId: string) {
        const {api} = this
        const request = {
            Id: docId,
            Status: "VALIDATION_ASKED"
        } as const;
        const doc = await api.Users.updateKycDocument(id, request).catch(function (e) {
            throw mangopayError(e, "submitKycDocument", {id, request})
        })
        return toKycProcess(doc)
    }

    /**
     * Fetch KYC documents for a user. Documents ordered in a particular way such that most relevant documents coming first, least relevant coming last.
     * @param id - user id
     */
    async kycDocuments(id: string) {
        const {api} = this
        const docs = await api.Users.getKycDocuments(id).catch(function (e) {
            throw mangopayError(e, "kycDocuments", {id})
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

    async bankAccounts(id: string, request: base.MethodOptionWithoutResponse) {
        const {api} = this
        const accounts = await api.Users.getBankAccounts(id, request).catch(function (e) {
            throw mangopayError(e, "bankAccounts", {id, request}, bankAccountMapper.mapping)
        })
        return accounts.map(x => bankAccountMapper.mapDirect(x) as schemas.BankAccount)
    }

    async fetchBankAccount(id: string, accountId: string) {
        const {api} = this
        const account = await api.Users.getBankAccount(id, accountId).catch(function (e) {
            throw mangopayError(e, "fetchBankAccount", {id, accountId}, bankAccountMapper.mapping)
        })
        return bankAccountMapper.mapDirect(account) as schemas.BankAccount
    }

    async createBankAccount(id: string, request: schemas.CreateBankAccountRequest) {
        const {api} = this
        const mangoPayRequest = bankAccountRequestMapper.mapInverse(request);
        const account = await api.Users.createBankAccount(id, mangoPayRequest as any).catch(function (e) {
            throw mangopayError(e, "createBankAccount", {id, request}, bankAccountRequestMapper.mapping)
        })
        return bankAccountMapper.mapDirect(account) as schemas.BankAccount
    }

    async deactivateBankAccount(id: string, accountId: string) {
        const {api} = this
        const account = await api.Users.deactivateBankAccount(id, accountId).catch(function (e) {
            throw mangopayError(e, "deactivateBankAccount", {id, accountId}, bankAccountMapper.mapping)
        })
        return bankAccountMapper.mapDirect(account) as schemas.BankAccount
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
        type: e.Type ?? "",
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
    [['DebitedFunds', 'Amount'], ['amount']],
    [['DebitedFunds', 'Currency'], ['currency']],
    [['BankAccountId'], ['details', 'account']],
    [['BankWireRef'], ['details', 'wire_ref']],
]
const payoutMapper = map.object(payoutMapping)

type PayIn = payIn.CreateCardDirectPayIn

const cardPayinMapping: Mapping<PayIn, schemas.CreateTransactionRequest> = [
    [['DebitedFunds', 'Amount'], ['amount']],
    [['DebitedFunds', 'Currency'], ['currency']],
    [['CardId'], ['details', 'card']],
]
const cardPayinMapper = map.object(cardPayinMapping)

function toKycProcess(doc: kycDocument.KycDocumentData): schemas.KYCProcess {
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


function parseTag(tag: string) {
    try {
        return JSON.parse(tag) as { org?: string, loc?: string }
    } catch (e) {
        return {}
    }
}
