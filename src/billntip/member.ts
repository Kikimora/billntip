import _ from "lodash";
import {intervalToDuration} from "date-fns";
import {Type} from "@sinclair/typebox";
import {Value} from "@sinclair/typebox/value";
import mangopay, {bankAccount, base, CountryISO, kycDocument} from "mangopay2-nodejs-sdk";
import {badRequestError, internalError, notFoundError} from "@app/lambda";
import {TraceAttributes} from "@app/diagnostics";
import {toCamelCase} from "@app/util";
import {UserAttribute} from "@src/users/attributes";
import Store, {InviteRequest, MemberItem, MembershipFilters, OrgRequest, RegisteredMemberItem} from "./store";
import {
    type BankAccount,
    type BankAccountsQuery,
    CreateBankAccountRequest,
    KYCProcessSchema,
    type TransactionsQuery
} from "./schemas";
import map, {Mapping} from "@app/lambda/mapper";

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

const RecipientSchema = Type.Object({
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

const paymentApi = new mangopay({
    clientId: 'urbankitchen',
    clientApiKey: "kUazwBMVhOL2tsjUamdO5sBkPSBXbiC1J2uhSPFSNyA0jpRZQX",
    baseUrl: 'https://api.sandbox.mangopay.com'
});

export interface MemberStoreOptions {
    table: string
}

export class MemberRepo {
    private store: Store;

    constructor(options: MemberStoreOptions) {
        this.store = new Store(options)
    }

    /**
     * Fetch member information from the store or create a new non-persistent member record.
     */
    async fetchOrCreate(username: string) {
        const member = new Member(username, this.store)
        await member.fetchOrCreate()
        return member
    }

    async fetch(username: string) {
        const member = new Member(username, this.store)
        await member.fetch()
        return member
    }

    newMember(username: string) {
        return new Member(username, this.store)
    }

    async createOrg(request: OrgRequest) {
        try {
            return await this.store.createOrg(request)
        } catch (e: any) {
            throw internalError("Unexpected error creating organisation").withContext("createOrg", {request, cause: e})
        }
    }

    async deleteOrg(orgId: string) {
        try {
            return await this.store.removeOrg(orgId)
        } catch (e: any) {
            throw internalError("Unexpected error removing organisation").withContext("deleteOrg", {orgId, cause: e})
        }
    }

    async invite(invite: InviteRequest) {
        try {
            return await this.store.inviteToOrg(invite)
        } catch (e: any) {
            switch (e.name) {
                case 'ConditionalCheckFailedException': {
                    throw badRequestError('Member already exists').withContext('invite', {invite})
                }
                default:
                    throw internalError("Unexpected error inviting a user").withContext('invite', {invite, cause: e})
            }
        }
    }

    async deleteInvite(username: string, orgId: string) {
        try {
            return await this.store.removeMembership(username, orgId)
        } catch (e: any) {
            throw internalError("Unexpected error removing invite").withContext("deleteInvite", {
                username,
                orgId,
                cause: e
            })
        }
    }
}

function toKycProcess(doc: kycDocument.KycDocumentData) {
    return {
        process_id: doc.Id,
        created_at: doc.CreationDate,
        processed_at: doc.ProcessedDate,
        status: doc.Status,
        refuse_reason: doc.RefusedReasonType,
        refuse_message: doc.RefusedReasonMessage
    }
}

//path, value, message

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

        const propertyMapping = _.find(mapping, function (mapping) {
            const [p1] = mapping
            return p1[p1.length - 1] === path
        })

        if (propertyMapping !== undefined) {
            path = '/' + propertyMapping[1].join('/')
        }

        return badRequestError(message ?? value.message, {path}).withContext({name, value})
    }

    return internalError(value.message, value.errors).withContext({name, value});
}

export class Member {

    private member?: MemberItem

    constructor(public readonly username: string,
                public readonly store: Store) {
    }

    async fetchOrCreate(force: boolean = false) {
        if (this.member !== undefined && !force) return this.member
        let member = await this.store.fetchMember(this.username)
        if (member === undefined)
            member = this.store.createMember(this.username)
        return this.member = member
    }

    async fetch(force: boolean = false) {
        if (this.member !== undefined && !force) return this.member
        const member = await this.store.fetchMember(this.username)
        if (member === undefined)
            throw notFoundError()
        return this.member = member
    }

    /**
     * Assert member exists and has all attributes.
     */
    private requireMember() {
        if (this.member === undefined) throw internalError("Unexpected error: member data is not loaded.")
        return this.member
    }

    /**
     * Assert member exists and has all attributes.
     */
    private requireRegisteredMember(): RegisteredMemberItem {
        const {mangopayUid, walletId} = this.requireMember()
        if (mangopayUid === undefined) throw internalError("User not registered.")
        if (walletId === undefined) throw internalError("User does not have a wallet.")
        return this.member as RegisteredMemberItem
    }

    /**
     * Fetch member memberships.
     */
    async memberships(filters: MembershipFilters = {accepted: false, rejected: false}) {
        return this.store.memberships(this.username, filters)
    }

    async acceptInvite(id: string) {
        const {username, store} = this

        async function acceptInvite(username: string, id: string) {
            try {
                return await store.acceptInvite(username, id)
            } catch (e: any) {
                switch (e.name) {
                    case 'ConditionalCheckFailedException': {
                        throw badRequestError('Invite already accepted or does not exists').withContext('acceptInvite')
                    }
                    default:
                        throw internalError("Cannot accept invite").withContext("acceptInvite", {cause: e})
                }
            }
        }

        const membership = await acceptInvite(username, id)
        if (membership === undefined) throw notFoundError()
        return membership
    }

    async rejectInvite(id: string) {
        const {username, store} = this
        try {
            return await store.rejectInvite(username, id)
        } catch (e: any) {
            switch (e.name) {
                case 'ConditionalCheckFailedException': {
                    throw badRequestError('Invite already does not exists').withContext('rejectInvite')
                }
                default:
                    throw internalError("Cannot reject invite").withContext("rejectInvite", {cause: e})
            }
        }
    }

    async fetchMembership(orgId: string) {
        const {username, store} = this

        async function fetchMembership(username: string, orgId: string) {
            try {
                return await store.fetchMembership(username, orgId)
            } catch (e: any) {
                throw internalError("Cannot fetch membership").withContext("fetchMembership", {cause: e})
            }
        }

        const membership = await fetchMembership(username, orgId)
        if (membership === undefined) throw notFoundError()
        return membership
    }

    /**
     * Save member information.
     */
    async save() {
        const {username, store} = this
        const member = this.requireMember()
        try {
            await store.updateMember(member)
        } catch (e: any) {
            throw internalError("Cannot save member").withContext("save", {username, cause: e})
        }
    }

    /**
     * Remove member record
     * @returns member record if it was removed
     */
    async delete() {
        const {username, store} = this
        try {
            return await store.removeMember(username)
        } catch (e: any) {
            throw internalError("Cannot remove member").withContext("remove", {username, cause: e})
        }
    }

    /**
     * Remove membership record
     * @param orgId target organisation id
     * @returns membership record if it was removed
     */
    async removeMembership(orgId: string) {
        const {username, store} = this
        try {
            return await store.removeMembership(username, orgId)
        } catch (e: any) {
            throw internalError("Cannot remove membership").withContext("removeMembership", {username, orgId, cause: e})
        }
    }

    /**
     * Refresh member information.
     */
    async refresh(userAttributes: UserAttribute[]) {
        const member = this.requireMember()
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
        const recipient = Value.Decode(RecipientSchema, userDetails)

        const mangoPayUser: mangopay.user.CreateUserNaturalOwnerData = {
            PersonType: "NATURAL",
            FirstName: recipient.first_name,
            LastName: recipient.last_name,
            Email: email ?? (this.username.indexOf('@') >= 0 ? this.username : `${this.username}@billntip.com`),
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
            Tag: "Recipient",
            UserCategory: "OWNER",
        }

        if (member.mangopayUid === undefined) {
            const response = await paymentApi.Users.create(mangoPayUser).catch(function (e) {
                throw mangopayError(e, "createUser", {mangoPayUser, member, userAttributes})
            })
            member.mangopayUid = response.Id
        } else {
            const request = {...mangoPayUser, Id: member.mangopayUid};
            await paymentApi.Users.update(request).catch(function (e) {
                throw mangopayError(e, "updateUser", {mangoPayUser, member, request, userAttributes})
            })
        }

        if (member.walletId === undefined) {
            const request: mangopay.wallet.CreateWallet = {
                Currency: "EUR",
                Description: "Bill&Tip recipient wallet.",
                Owners: [member.mangopayUid],
                Tag: "Recipient"
            }
            const response = await paymentApi.Wallets.create(request).catch(function (e) {
                throw mangopayError(e, "createWallet", {request, member, userAttributes})
            })
            member.walletId = response.Id
        }
    }

    async fetchWallet() {
        const member = this.requireRegisteredMember()
        const response = await paymentApi.Wallets.get(member.walletId)
            .catch(function (e) {
                throw mangopayError(e, "fetchWallet", {member})
            })
        return {
            id: this.username,
            created_at: response.CreationDate,
            description: response.Description,
            balance: {amount: response.Balance.Amount, currency: response.Balance.Currency}
        }
    }

    async fetchUser() {
        const {mangopayUid} = this.requireRegisteredMember()
        const response = await paymentApi.Users.get(mangopayUid)
            .catch(function (e) {
                throw mangopayError(e, "fetchUser", {mangopayUid})
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
        const {mangopayUid} = this.requireRegisteredMember()
        const users = paymentApi.Users as unknown as RegulatoryDataProvider;
        const response = await users.getRegulatory(mangopayUid)
            .catch(function (e) {
                throw mangopayError(e, "fetchRegulatoryStatus", {mangopayUid})
            })
        return {
            action_code: response.ActionCode,
            blocked: {
                inflows: response.ScopeBlocked.Inflows,
                outflows: response.ScopeBlocked.Outflows,
            }
        }
    }

    async transactions(query: TransactionsQuery) {
        const member = this.requireRegisteredMember()

        function parseTag(tag: string) {
            try {
                return JSON.parse(tag) as { org?: string, loc?: string }
            } catch (e) {
                return {}
            }
        }

        const request = {parameters: toQuery(query),};
        const response = await paymentApi.Wallets.getTransactions(member.walletId, request).catch(function (e) {
            throw mangopayError(e, "transactions", {member, request})
        })
        return response.map(function (tx) {
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
        })
    }

    async startVerification(pages: string[]) {
        const member = this.requireRegisteredMember()
        const {mangopayUid} = member

        let doc = await paymentApi.Users.createKycDocument(mangopayUid, {Type: "IDENTITY_PROOF"}).catch(function e() {
            throw mangopayError(e, "createKycDocument", {mangopayUid})
        })

        const uploads = pages.map(function (page) {
            return paymentApi.Users.createKycPage(mangopayUid, doc.Id, {File: page}).catch(function (e) {
                throw mangopayError(e, "createKycPage", {doc, page})
            })
        })
        await Promise.all(uploads)

        const updateDocRequest = {
            Id: doc.Id,
            Status: "VALIDATION_ASKED"
        } as const;
        doc = await paymentApi.Users.updateKycDocument(mangopayUid, updateDocRequest).catch(function (e) {
            throw mangopayError(e, "updateKycDocument", {doc, updateDocRequest})
        })

        member.kycDocumentId = doc.Id
        await this.save()

        return toKycProcess(doc);
    }

    async fetchVerificationStatus(): Promise<Partial<KYCProcessSchema>> {
        let {mangopayUid, kycDocumentId} = this.requireRegisteredMember()
        if (kycDocumentId === undefined) {
            kycDocumentId = await paymentApi.Users.get(mangopayUid).catch(function (e) {
                throw mangopayError(e, "fetchProcessId", {mangopayUid})
            }).then(function ({ProofOfIdentity}) {
                return ProofOfIdentity === null ? undefined : ProofOfIdentity
            })
        }
        if (kycDocumentId === undefined) {
            return {
                status: "NOT_STARTED"
            }
        }
        const doc = await paymentApi.KycDocuments.get(kycDocumentId).catch(function (e) {
            throw mangopayError(e, "fetchVerificationStatus", {mangopayUid, kycDocumentId})
        })
        return toKycProcess(doc)
    }

    async fetchBankAccounts(query: BankAccountsQuery): Promise<BankAccount[]> {
        const {mangopayUid} = this.requireRegisteredMember()
        const request = {parameters: toQuery(query),};
        const accounts = await paymentApi.Users.getBankAccounts(mangopayUid, request).catch(function (e) {
            throw mangopayError(e, "fetchBankAccounts", {mangopayUid, query}, bankAccountMapper.mapping)
        })
        return accounts.map(x => bankAccountMapper.mapDirect(x) as BankAccount)
    }

    async fetchBankAccount(bankAccountId: string): Promise<BankAccount> {
        const {mangopayUid} = this.requireRegisteredMember()
        const account = await paymentApi.Users.getBankAccount(mangopayUid, bankAccountId).catch(function (e) {
            throw mangopayError(e, "fetchBankAccount", {mangopayUid, bankAccountId}, bankAccountMapper.mapping)
        })
        return bankAccountMapper.mapDirect(account) as BankAccount
    }

    async deactivateBankAccount(bankAccountId: string): Promise<BankAccount> {
        const {mangopayUid} = this.requireRegisteredMember()
        const account = await paymentApi.Users.deactivateBankAccount(mangopayUid, bankAccountId).catch(function (e) {
            throw mangopayError(e, "deactivateBankAccount", {mangopayUid, bankAccountId}, bankAccountMapper.mapping)
        })
        return bankAccountMapper.mapDirect(account) as BankAccount
    }

    async createBankAccount(body: CreateBankAccountRequest): Promise<BankAccount> {
        const {mangopayUid} = this.requireRegisteredMember()
        const mangoPayRequest = bankAccountRequestMapper.mapInverse(body);
        const account = await paymentApi.Users.createBankAccount(mangopayUid, mangoPayRequest as any).catch(function (e) {
            throw mangopayError(e, "createBankAccount", {
                mangopayUid,
                mangoPayRequest
            }, bankAccountRequestMapper.mapping)
        })
        return bankAccountMapper.mapDirect(account) as BankAccount
    }
}

const bankAccountRequestMapping: Mapping<bankAccount.CreationDetails, CreateBankAccountRequest> = [
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

const bankAccountMapping: Mapping<bankAccount.Data, BankAccount> = [
    [['Id'], ['id']],
    [['Active'], ['active']],
    [['CreationDate'], ['created_at']],
    ...bankAccountRequestMapping
]
const bankAccountMapper = map.object(bankAccountMapping)
const bankAccountRequestMapper = map.object(bankAccountRequestMapping)


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
                    return toCamelCase(key)
            }
        })
        .mapValues(function (value, key) {
            switch (key) {
                case 'Sort':
                    if (typeof value === 'string') {
                        const [column, dir] = value.split(':')
                        return `${toCamelCase(column)}:${dir}`
                    }
                    return value
                default:
                    return value
            }
        })
        .value()
}


