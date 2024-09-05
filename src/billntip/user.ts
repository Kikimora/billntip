import _ from "lodash";
import {badRequestError, internalError, notFoundError} from "@app/lambda";
import {UserAttribute} from "@src/users/attributes";
import ProfileRepo from "@src/users/user";
import Store, * as store from "./store";
import MangopayUser, {MangopayAPI, MangopayOptions} from "./mangopay-user";
import {toMembership} from "@src/billntip/util";

export interface StoreOptions {
    table: string
}

export default class UserRepo {
    public readonly store: Store;

    constructor(options: StoreOptions,
                public readonly mangopayOptions: MangopayOptions,
                public readonly profiles: ProfileRepo) {
        this.store = new Store(options)
    }

    /**
     * Fetch member information from the store or create a new non-persistent member record.
     */
    async fetchOrCreate(username: string) {
        const recipient = new User(username, this)
        await recipient.fetchOrCreate()
        return recipient
    }

    async fetch(username: string) {
        const member = new User(username, this)
        await member.fetch()
        return member
    }

    newUser(username: string) {
        return new User(username, this)
    }

    async createOrg(request: store.OrgRequest) {
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

    async invite(invite: store.InviteRequest) {
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

export class User {

    private userItem?: store.UserItem

    constructor(public readonly username: string,
                private readonly repo: UserRepo) {
    }

    get store() {
        return this.repo.store
    }

    get mangopayOptions() {
        return this.repo.mangopayOptions
    }

    get profiles() {
        return this.repo.profiles
    }

    async fetchOrCreate(force: boolean = false) {
        if (this.userItem !== undefined && !force) return this.userItem
        let user = await this.store.fetchUser(this.username)
        if (user === undefined)
            user = this.store.createMember(this.username)
        return this.userItem = user
    }

    async fetch(force: boolean = false) {
        if (this.userItem !== undefined && !force) return this.userItem
        const username = this.username;
        const user = await this.store.fetchUser(username)
        if (user === undefined)
            throw notFoundError().withContext("fetch", {username})
        return this.userItem = user
    }

    /**
     * Assert member exists and has all attributes.
     */
    private requireUser() {
        if (this.userItem === undefined) throw internalError("Unexpected error: member data is not loaded.")
        return this.userItem
    }

    /**
     * Fetch member memberships.
     */
    async memberships(filters: store.MembershipFilters = {accepted: false, rejected: false}) {
        const {username, profiles, store} = this
        const memberships = await this.store.memberships(this.username, filters);
        try {
            const oids = _(memberships).map('orgId').uniq().value()
            const uids = _(memberships).map('invited_by').concat(this.username).compact().uniq().value()
            const [users, orgs] = await Promise.all([
                profiles.batchFetch(uids).then(function (users) {
                    return _.keyBy(users, 'id')
                }),
                store.batchGetOrgs(oids).then(function (orgs) {
                    return _.keyBy(orgs, 'id')
                })
            ])
            return memberships.map(function (member) {
                const inviter = member.invited_by !== undefined ? users[member.invited_by] : undefined
                const org = orgs[member.orgId]
                return toMembership(member, org, users[member.id], inviter)
            })
        } catch (e:any) {
            throw internalError("Unexpected error loading user memberships.")
                .withContext("memberships", {filters, username, cause: e})
        }
    }

    async acceptInvite(orgId: string) {
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

        const membership = await acceptInvite(username, orgId)
        if (membership === undefined) throw notFoundError()
        return await this.toMembership(membership);
    }

    async rejectInvite(id: string) {
        const {username, store} = this

        async function rejectInvite(username: string, id: string) {
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

        const membership = await rejectInvite(username, id)
        if (membership === undefined) return undefined
        return await this.toMembership(membership)
    }

    private async toMembership(membership: store.MemberItem) {
        const {username, store, profiles} = this
        const [org, users] = await Promise.all([
            store.fetchOrg(membership.orgId),
            profiles.batchFetch(_.compact([username, membership.invited_by])).then(function (x) {
                return _.keyBy(x, 'id')
            }),
        ])
        return toMembership(membership, org ?? {id: membership.orgId, title: "", created_at: 0},
            users[username],
            membership.invited_by !== undefined ? users[membership.invited_by] : undefined)
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
        return await this.toMembership(membership)
    }

    /**
     * Save member information.
     */
    async save() {
        const {username, store} = this
        const member = this.requireUser()
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
    async refreshMangopayUser(userAttributes: UserAttribute[]) {
        const member = this.requireUser()

        const service = new MangopayAPI(this.mangopayOptions)
        let mangopayUid = member.mangopayUid
        if (mangopayUid === undefined) {
            mangopayUid = await service.createUser(this.username, userAttributes)
        } else {
            mangopayUid = await service.updateUser(mangopayUid, this.username, userAttributes)
        }
        member.mangopayUid = mangopayUid
        let walletId = member.walletId
        if (walletId === undefined) {
            walletId = await service.createWallet(mangopayUid)
        }
        member.walletId = walletId
        return new MangopayUser(this.mangopayOptions, this.username, {
            mangopayUid: mangopayUid,
            walletId: walletId,
        })
    }

    get mangopayUser() {
        const {mangopayUid, walletId} = this.requireUser()
        if (mangopayUid === undefined) throw internalError("User not registered.")
        if (walletId === undefined) throw internalError("User does not have a wallet.")
        return new MangopayUser(this.mangopayOptions, this.username, {
            mangopayUid: mangopayUid,
            walletId: walletId,
        })
    }

    async fetchLocations() {
        const {username, store} = this
        try {
            const memberships = await store.memberships(username)
            const locations = memberships.reduce(function (batch, {orgId, locations}) {
                if (locations !== undefined) {
                    locations.forEach(function (locationId) {
                        batch.add({orgId, locationId: locationId})
                    })
                }
                return batch
            }, new Set<{ orgId: string, locationId: string }>())
            return await store.batchGetLocations(Array.from(locations))
        } catch (e: any) {
            throw internalError("Cannot fetch user locations").withContext("fetchLocations", {username, cause: e})
        }
    }
}

