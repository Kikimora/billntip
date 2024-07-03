import {Type} from "@sinclair/typebox";
import mangopay from "mangopay2-nodejs-sdk";
import Store, {InviteRequest, MemberItem, MembershipFilters, OrgRequest} from "./store";
import {badRequestError, internalError, notFoundError} from "@app/lambda";
import _ from "lodash";
import {intervalToDuration} from "date-fns";
import {Value} from "@sinclair/typebox/value";
import {UserAttribute} from "@src/users/attributes";
import {type TransactionsQuery} from "@src/billntip/schemas";
import {toCamel} from "@app/util";

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
            throw internalError("Unexpected error removing organisation").withContext("removeOrg", {orgId, cause: e})
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

    private requireMember() {
        if (this.member === undefined) throw internalError("Unexpected error: member data is not loaded.")
        return this.member
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
        const address = JSON.parse(addressJSON ?? "")
        const tos = JSON.parse(tosJSON)
        const birthdate = Date.parse(birthdateStr)
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
            Nationality: recipient.nationality as any,
            CountryOfResidence: recipient.address.country as any,
            TermsAndConditionsAccepted: true,
            Address: {
                AddressLine1: recipient.address.street_address ?? "",
                AddressLine2: "",
                City: recipient.address.locality ?? "",
                Region: recipient.address.region ?? "",
                PostalCode: recipient.address.postal_code ?? "",
                Country: recipient.address.country as any
            },
            Tag: "Recipient",
            UserCategory: "OWNER",
        }
        if (member.mangopayUid === undefined) {
            const response = await paymentApi.Users.create(mangoPayUser)
            member.mangopayUid = response.Id
        } else {
            await paymentApi.Users.update({...mangoPayUser, Id: member.mangopayUid})
        }

        if (member.walletId === undefined) {
            const wallet: mangopay.wallet.CreateWallet = {
                Currency: "EUR",
                Description: "Bill&Tip recipient wallet.",
                Owners: [member.mangopayUid],
                Tag: "Recipient"
            }
            const response = await paymentApi.Wallets.create(wallet)
            member.walletId = response.Id
        }
    }

    async fetchWallet() {
        const member = this.requireMember()
        if (member.walletId === undefined) throw internalError("User does not have a wallet")
        const response = await paymentApi.Wallets.get(member.walletId)
        return {
            id: this.username,
            created_at: response.CreationDate,
            description: response.Description,
            balance: {amount: response.Balance.Amount, currency: response.Balance.Currency}
        }
    }

    async transactions(query: TransactionsQuery) {
        const member = this.requireMember()
        if (member.walletId === undefined) throw internalError("User does not have a wallet")
        const response = await paymentApi.Wallets.getTransactions(member.walletId, {
            parameters: toQuery(query),
        })

        function parseTag(tag: string) {
            try {
                return JSON.parse(tag) as { from?: string, to?: string }
            } catch (e) {
                return {}
            }
        }

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
}

function toQuery(query: Record<string, string | number>): (mangopay.base.FilterOptions & mangopay.base.PaginationOptions) {
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
                    return toCamel(key)
            }
        })
        .mapValues(function (value, key) {
            switch (key) {
                case 'Sort':
                    if (typeof value === 'string') {
                        const [column, dir] = value.split(':')
                        return `${toCamel(column)}:${dir}`
                    }
                    return value
                default:
                    return value
            }
        })
        .value()
}