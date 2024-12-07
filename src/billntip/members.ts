import _ from "lodash";
import {SES} from "@aws-sdk/client-ses";
import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import ProfileRepo, {
    UserAttribute as ProfileAttribute,
    UserItem as Profile,
    UserRepoOptions as ProfileRepoOptions
} from "@src/users/user";
import {generatePassword} from "@src/users/cognito";
import {TemplateRepo, TemplateRepoOptions} from "@src/templates";
import {errorWithContext} from "@app/diagnostics";
import {badRequestError, internalError, notFoundError} from "@app/lambda";
import Store, {MemberAttributes, MemberItem, Org} from "./store";
import {keyToToken, tokenToKey, toLocation, toUserInfo} from "./util";
import * as schemas from "./schemas";

interface UserServiceOptions {
    profileRepo: ProfileRepoOptions
    userPoolId: string
    templates: TemplateRepoOptions,
}

const cognito = new CognitoIdentityProvider()
const ses = new SES()

export class Service {
    private readonly profileRepo: ProfileRepo;
    private readonly userPoolId: string;
    private readonly templates: TemplateRepo;

    constructor(options: UserServiceOptions) {
        this.profileRepo = new ProfileRepo(options.profileRepo)
        this.userPoolId = options.userPoolId
        this.templates = new TemplateRepo(options.templates)
    }

    /**
     * If user with a given email does not exist then send invite
     */
    async inviteMember(inviter: Member, email: string) {
        const {profileRepo} = this

        await inviter.fetchProfile(true)
        const inviterProfile = inviter.profile.attributes;
        const invitedBy = {
            username: inviter.id,
            email: inviterProfile['email'] ?? '',
            first_name: inviterProfile['first_name'] ?? '',
            last_name: inviterProfile['last_name'] ?? '',
        }
        const invitedTo = {
            id: inviter.org.id,
            title: inviter.org.title
        }
        const metadata = {
            ..._.mapKeys(invitedBy, (_1, key) => `invited_by_${key}`),
            ..._.mapKeys(invitedTo, (_1, key) => `org_${key}`),
            env: process.env.ENV ?? "dev"
        }
        let invitee = inviter.organization.newMember(email)
        try {
            if (await invitee.fetchProfile()) {
                const profile = invitee.profile.attributes
                let attributes = _.map(profile, function (v, k) {
                    return {name: k, value: v}
                })
                attributes = profileRepo.normalAttributes(attributes)
                try {
                    await this.cognitoCreateUser(invitee.id, true, attributes, metadata)
                    return invitee
                } catch (e: any) {
                    if (e.name !== 'UnsupportedUserStateException')
                        throw e
                    await this.sendInviteMessage(invitee.id, email, attributes, metadata)
                    return invitee
                }
            } else {
                const username = await this.cognitoCreateUser(email, false, [], metadata)
                const user = await profileRepo.create(username, "trusted", [{
                    name: "email",
                    value: email,
                    verified: true
                }])
                invitee = inviter.organization.newMember(user.item)
            }

            await invitee.create({
                role: "member",
                invited_by: inviter.id,
                invited_at: Date.now() / 1000
            })

            return invitee

        } catch (e: any) {
            throw errorWithContext(e, 'adminCreateUser', {
                email, inviter: inviter.id, metadata
            })
        }
    }

    private async cognitoCreateUser(email: string, resend: boolean, attributes: ProfileAttribute[], metadata: Record<string, string>) {
        const {userPoolId} = this
        const password = await generatePassword(userPoolId)
        const response = await cognito.adminCreateUser({
            UserPoolId: userPoolId,
            Username: email,
            MessageAction: resend ? "RESEND" : undefined,
            UserAttributes: [{
                Name: 'email',
                Value: email
            }, {
                Name: 'email_verified',
                Value: 'true'
            }],
            TemporaryPassword: password,
            ClientMetadata: {
                ...metadata,
                _attributes: JSON.stringify(attributes),
                password
            }
        })
        if (response.User?.Username === undefined) throw internalError("adminCreateUser didn't return username.")
        return response.User.Username
    }

    async sendInviteMessage(username: string, email: string, attributes: ProfileAttribute[], metadata: Record<string, string>) {
        const {templates} = this
        //User with this username exists and confirmed
        const template = await templates.fetchTemplate("admin-create-user-email.html")
        await ses.sendEmail({
            Source: "no-reply@billntip.com",
            Destination: {ToAddresses: [email]},
            Message: {
                Body: {
                    Html: {
                        Charset: "utf8",
                        Data: template({
                            attributes: _(attributes)
                                .filter(x => x.verified || x.verified === undefined)
                                .keyBy('name')
                                .mapValues('value')
                                .value(),
                            metadata,
                            username: username,
                            code: "",
                            link: "",
                            type: "invite"
                        })
                    }
                },
                Subject: {
                    Charset: "utf-8",
                    Data: `${metadata['invited_by_first_name']} invited you to join the ${metadata['org_title']} team on Bill&Tip`
                }
            }
        })
    }
}

export interface OrganizationsQuery {
    cursor?: string
    username?: string
}

export class Repo {

    private readonly store: Store

    constructor(table: string, private readonly profileRepo: ProfileRepo) {
        this.store = new Store({table})
    }

    async organizations({cursor, username}: OrganizationsQuery) {
        const {store} = this
        try {
            if (username !== undefined) {
                const adminOf = await store.memberships(username, {accepted: true, rejected: false, role: "admin"})
                return {
                    organizations: await store.batchGetOrgs(adminOf.map(x => x.orgId))
                }
            }
            const {organizations, next} = await this.store.organizations(tokenToKey(cursor))
            return {
                organizations,
                next: keyToToken(next)
            }
        } catch (e) {
            throw internalError().withContext("organizations", {cursor: cursor})
        }
    }

    organization(org: Org) {
        return new Organization(org, this.store, this.profileRepo)
    }
}

export class Member {
    private _attributes?: MemberItem
    private _profile?: Profile
    private _invitedBy?: Profile
    public readonly id: string

    constructor(profile: string | Profile, private readonly _org: Organization, attributes?: MemberItem) {
        if (typeof profile === "string") {
            this.id = profile
        } else {
            this.id = profile.id
            this._profile = profile
        }
        this._attributes = attributes
    }

    get hasProfile() {
        return this._profile !== undefined
    }

    get profile(): Readonly<Profile> {
        return this._profile!
    }

    get attributes(): Readonly<MemberItem> {
        return this._attributes!
    }

    get invitedBy() {
        return this._invitedBy
    }

    get store() {
        return this._org.store
    }

    get profileRepo() {
        return this._org.profileRepo
    }

    get org() {
        return this._org.data
    }

    get organization() {
        return this._org
    }

    /**
     * Fetch {@link attributes} if they were not fetched before.
     */
    async fetch(): Promise<Readonly<MemberItem> | undefined> {
        if (this._attributes !== undefined)
            this._attributes = await this.store.fetchMembership(this.id, this.org.id)
        return this._attributes
    }

    /**
     * Fetch {@link profile} and {@link invitedBy} if they were not fetched before.
     */
    async fetchRelatedProfiles() {
        const {profileRepo, _profile, _invitedBy, id, org, _attributes} = this
        const ids = []
        if (_profile === undefined) ids.push(id)
        const invitedBy = _attributes?.invited_by
        if (_invitedBy !== undefined && invitedBy !== undefined)
            ids.push(invitedBy)
        if (ids.length === 0) return
        try {
            const profiles = await profileRepo.batchFetch(ids)
            for (const p of profiles) {
                if (p.id === id) this._profile = p
                if (p.id === invitedBy) this._invitedBy = p
            }
        } catch (e) {
            throw internalError().withContext("fetchRelatedProfiles", {id, org, _attributes})
        }
    }

    /**
     * Fetch member {@link profile} if it was not fetched before.
     * @param force - throw error if user not found rather than returning undefined
     */
    async fetchProfile(force: boolean = false) {
        const {profileRepo, _profile, id, org} = this
        if (_profile !== undefined) return _profile
        try {
            return this._profile = await profileRepo.fetchAttributes(this.id, {allowUnverifiedAlias: true})

        } catch (e: any) {
            if (!force && e.name === 'UserNotFoundException') {
                return undefined
            }
            throw internalError().withContext("fetchUser", {username: id, org})
        }
    }

    /**
     * Create member and populate {@link attributes}
     */
    async create(attributes: MemberAttributes) {
        const {store, org, id} = this
        const member = await store.putMember(id, org, attributes, "create")
        if (member === undefined) {
            throw badRequestError('Member already exists').withContext('createMember', {
                org: org,
                username: id
            })
        }
        this._attributes = member
    }

    /**
     * Batch get member locations.
     */
    async locations() {
        const {store, org} = this
        const locations = this.attributes.locations
        if (locations === undefined) return []
        if (locations.size === 0) return []
        try {
            return await store.batchGetLocations(Array.from(locations, function (locationId) {
                return {orgId: org.id, locationId}
            }))
        } catch (e: any) {
            throw internalError("fetchLocations", {orgId: org.id, locations, cause: e})
        }
    }

    /**
     * Delete member and populate {@link attributes}
     */
    async delete() {
        const {store, org, id} = this
        try {
            return this._attributes = await store.removeMembership(id, org.id)
        } catch (e: any) {
            throw internalError().withContext('delete', {org, id, cause: e})
        }
    }

    async update(body: { role: "admin" | "member" }) {
        const {store, org, id} = this
        try {
            const response = await store.updateMembership(id, org.id, body)
            if (response === undefined) throw notFoundError()
            this._attributes = response
            return response
        } catch (e: any) {
            throw internalError().withContext('update', {org, id, body, cause: e})
        }
    }
}

export class Organization {
    constructor(public readonly data: Readonly<Org>,
                public readonly store: Store,
                public readonly profileRepo: ProfileRepo) {
    }

    newMember(user: string | Profile, attributes?: MemberItem) {
        return new Member(user, this, attributes)
    }

    async members({location, from}: schemas.MembersQuery) {
        const {store, data} = this
        let memberItems: MemberItem[]
        let next: string | undefined
        let memberIds: string[] | undefined
        if (location !== undefined) {
            memberIds = await store.locationMembers(data.id, location)
            if (memberIds === undefined) {
                throw notFoundError()
            }
        }
        const orgMembers = await store.orgMembers(data.id, tokenToKey(from), memberIds)
        memberItems = orgMembers.members
        next = keyToToken(orgMembers.lastKey)
        const members = await this.membersWithRelatedUsers(data, memberItems);
        return {
            members,
            next
        }
    }

    private async membersWithRelatedUsers(org: Org, memberItems: MemberItem[]) {
        const {profileRepo} = this
        const response = new Response()
        try {
            const [users, invitees] = await Promise.all([
                await profileRepo.batchFetch(_(memberItems).map('id').uniq().valueOf()),
                await profileRepo.batchFetch(_(memberItems).map('invited_by').compact().uniq().valueOf())
            ])
            response.addProfiles(users)
            response.addProfiles(invitees)
            return memberItems.map(function (member) {
                return response.buildFromItem(member)
            });
        } catch (e: any) {
            throw internalError("Unexpected error").withContext("membersWithRelatedUsers", {org, memberItems})
        }
    }

    async fetchMember(id: string) {
        const {store, data} = this
        const member = await store.fetchMembership(id, data.id).catch(function (e) {
            throw internalError().withContext("fetchMember", {org: data, id, cause: e})
        })
        if (member === undefined) throw notFoundError().withContext("fetchMember", {org: data, id})
        return new Member(id, this, member)
    }

    async locations(query: schemas.LocationsQuery) {
        const {store, data: org} = this
        const {data, lastKey} = await store.locations(org.id, {
            title: query.title,
            archived: query.archived ?? false,
            startKey: tokenToKey(query.start_key)
        })
        return {
            lastKey: keyToToken(lastKey),
            data: data.map(toLocation)
        }
    }

    async fetchLocation(id: string) {
        const {store, data: org} = this
        const location = await store.location(org.id, id).catch(function (e) {
            throw internalError().withContext("fetchLocation", {org: org.id, id, cause: e})
        })
        if (location === undefined) throw notFoundError().withContext("fetchLocation", {org: org.id, id})
        return toLocation(location)
    }
}

export class Response {
    private profiles: Record<string, Profile> = {}
    private orgs: Record<string, Org> = {}
    private members: MemberItem[] = []

    addProfile(profile: Profile) {
        this.profiles[profile.id] = profile
    }

    addProfiles(profiles: Profile[]) {
        for (const p of profiles) {
            this.addProfile(p)
        }
    }

    addOrg(org: Org) {
        this.orgs[org.id] = org
    }

    addMember(member: Member) {
        if (member.hasProfile) {
            this.addProfile(member.profile)
        }
        this.addOrg(member.org)
        this.members.push(member.attributes)
    }

    addMemberItem(item: MemberItem) {
        this.members.push(item)
    }

    buildFromMember(member: Member) {
        const invitedBy = this.profiles[member.attributes.invited_by]
        const profile = member.hasProfile ? member.profile : this.profiles[member.id]
        const org = member.org
        return Response.buildFromItem(member.attributes, org, profile, invitedBy);
    }

    buildFromItem(x: MemberItem) {
        const invitedBy = x.invited_by !== undefined ? this.profiles[x.invited_by] : undefined
        const profile = this.profiles[x.id]
        const org = this.orgs[x.orgId] ?? {title: "", id: x.orgId}
        return Response.buildFromItem(x, org, profile, invitedBy);
    }

    public static buildFromMember(member: Member, invitedBy?: Profile) {
        const profile = member.profile
        const org = member.org
        invitedBy = member.invitedBy ?? invitedBy
        return Response.buildFromItem(member.attributes, org, profile, invitedBy);
    }

    public static buildFromItem(member: MemberItem, org: Org, profile?: Profile, invitedBy?: Profile): schemas.Member {
        return ({
            id: member.id,
            accepted_at: member.accepted_at,
            invited_at: member.invited_at ?? 0,
            invited_by: toUserInfo(invitedBy),
            user: toUserInfo(profile),
            org: {
                title: org.title ?? "",
                id: org.id
            },
            rejected_at: member.rejected_at,
            role: member.role === "admin" ? "admin" : "member",
        });
    }
}