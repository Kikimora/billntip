import {DynamoDB} from "@aws-sdk/client-dynamodb";
import _ from "lodash";
import {uuid} from "short-uuid";
import {DDB, internalError} from "@app/lambda";
import * as schemas from "./schemas";

// pk               sk              attributes
// Users
// U#<username>     U               mangopayUid, walletId, locations[]
// U#<username>     O#<name>        role, invited_by, invited_at, accepted_at, rejected_at
// U#<name>         L#<loc id>      org_id, created_at

// Organisations
// O#<name>         O               title, created_at
// O#<name>         U#<username>    same as U:<username>, O#<name>

//Locations
// O#<name>         L#<loc id>      title, created_at, updated_at, image_url, deleted, users[]

const UserSchema = {
    key: DDB.Item({
        pk: DDB.TemplateLiteral([DDB.Literal(`U#`), DDB.String]),
        sk: DDB.Literal("U")
    }),
    item: DDB.Item({
        mangopayUid: DDB.Optional(DDB.String),
        walletId: DDB.Optional(DDB.String)
    })
}
type UsersTable = DDB.Table<typeof UserSchema>

export interface UserItem extends DDB.NonKeyType<UsersTable> {
    pk: string
}

const MemberSchema = {
    key: DDB.Key({
        pk: DDB.TemplateLiteral([DDB.Literal(`U#`), DDB.String]),
        sk: DDB.TemplateLiteral([DDB.Literal(`O#`), DDB.String]),
    }),
    item: DDB.Item({
        role: DDB.String,
        invited_by: DDB.String,
        invited_at: DDB.Number,
        accepted_at: DDB.Optional(DDB.Number),
        rejected_at: DDB.Optional(DDB.Number),
        locations: DDB.Optional(DDB.StringSet)
    })
}
type MemberTable = DDB.Table<typeof MemberSchema>
type MemberKey = DDB.KeyType<MemberTable>

export interface MemberItem extends DDB.NonKeyType<MemberTable> {
    id: string
    orgId: string
}

export type MemberAttributes = Pick<DDB.NonKeyType<MemberTable>, 'invited_by' | 'role' | 'invited_at'>

const TipSetting = DDB.Item({
    questions: DDB.Optional(DDB.Array(DDB.String)),
    comment: DDB.Optional(DDB.Boolean),
    payment_methods: DDB.Optional(DDB.StringSet),
    tips: DDB.Optional(DDB.NumberSet),
    type: DDB.Union([DDB.Literal("individual"), DDB.Literal("common")])
});
const OrgSchema = {
    key: DDB.Key({
        pk: DDB.TemplateLiteral([DDB.Literal(`O#`), DDB.String]),
        sk: DDB.Literal("O")
    }),
    item: DDB.Item({
        title: DDB.String,
        created_at: DDB.Number,
        tip_settings: TipSetting
    })
}
type OrgTable = DDB.Table<typeof OrgSchema>

export interface Org extends DDB.NonKeyType<OrgTable> {
    id: string
}

type OrgKey = DDB.KeyType<OrgTable>

export interface OrgRequest {
    title: string
}

const LocationSchema = {
    key: DDB.Key({
        pk: DDB.TemplateLiteral([DDB.Literal(`O#`), DDB.String]),
        sk: DDB.TemplateLiteral([DDB.Literal(`L#`), DDB.String]),
    }),
    item: DDB.Item({
        lowercase_title: DDB.String,
        created_at: DDB.Number,
        updated_at: DDB.Number,
        image: DDB.Item({
            id: DDB.String,
            version: DDB.Number,
        }),
        deleted: DDB.Boolean,
        users: DDB.StringSet,
        title: DDB.String,
        tip_settings: TipSetting,
        email: DDB.Optional(DDB.String),
        phone: DDB.Optional(DDB.String),
        address: DDB.Optional(DDB.String),
        goal: DDB.Optional(schemas.Goal)
    })
}
type LocationTable = DDB.Table<typeof LocationSchema>

export interface LocationItem extends DDB.NonKeyType<LocationTable> {
    pk: string
    sk: string
}

const Key = DDB.Key({
    pk: DDB.String,
    sk: DDB.String
})
const Data = {
    key: Key,
    item: DDB.Merge([UserSchema.item, MemberSchema.item, OrgSchema.item, LocationSchema.item] as const)
}
type DataTable = DDB.Table<typeof Data>

export type Key = DDB.KeyType<DataTable>

export interface StoreOptions {
    db?: DynamoDB
    table: string
}

export interface InviteRequest {
    username: string,
    org: {
        id: string,
        title: string
    },
    invited_by: string,
    role?: string
}

export interface MembershipFilters {
    accepted?: boolean
    rejected?: boolean
    role?: string
}

function makeMembershipItem(record: DDB.ItemType<MemberTable>, username?: string, org?: string): MemberItem {
    //Aug 2024: This is a migration from old invited_by format to the new one. Old format had some info about invitee, new format only has invitee id.
    if (record.invited_by != null && typeof record.invited_by === "object") {
        record.invited_by = record.invited_by['username']
    }
    const pk = username ?? record.pk.substring(2/*U#.length*/)
    const sk = org ?? record.sk.substring(2/*O#.length*/)
    return {
        ...record,
        id: pk,
        orgId: sk
    };
}


export default class Store {
    db: DDB.DynamoDB;
    data: DataTable;
    inverse: DataTable;
    table: string;

    constructor(options: StoreOptions) {
        this.db = DDB.dynamodb({db: options.db})
        this.table = options.table
        this.data = this.db.table(this.table, Data)
        this.inverse = this.db.table(this.table, Data, "inverse")
    }

    async memberships(username: string, filters: MembershipFilters = {
        accepted: true,
        rejected: false
    }): Promise<MemberItem[]> {
        const pk = `U#${username}`
        const Membership = this.data.narrow(MemberSchema)
        const {Items: invites} = await Membership.query({
            keyCondition: ({key, ref}) =>
                `${key.pk} = ${ref('pk')} AND begins_with(${key.sk}, ${ref('prefix')})`,
            filter: ({attr, ref}) => Object
                .entries(filters)
                .map(([key, value]) => {
                    const prop = key as keyof MembershipFilters
                    switch (prop) {
                        case 'accepted':
                            return value ? `attribute_exists(${attr.accepted_at})` : `attribute_not_exists(${attr.accepted_at})`
                        case 'rejected':
                            return value ? `attribute_exists(${attr.rejected_at})` : `attribute_not_exists(${attr.rejected_at})`
                        case 'role':
                            return `${attr.role} = ${ref.val(value)}`
                    }
                })
                .join(' AND ')
        }, {pk, prefix: "O#"})
        return _.map(invites, x => makeMembershipItem(x))
    }

    /**
     * Create new invite if another does not exist or was rejected.
     * @deprecated - use putMember
     */
    async inviteToOrg(request: InviteRequest): Promise<MemberItem> {
        const Membership = this.data.narrow(MemberSchema)
        const item = {
            pk: `U#${request.username}`,
            sk: `O#${request.org.id}`,
            invited_by: request.invited_by,
            invited_at: Date.now() / 1000,
            role: request.role ?? 'member',
            org: {
                id: request.org.id,
                title: request.org.title
            },
        } as const;
        await Membership.put({
            item,
            condition: ({attr}) => `attribute_not_exists(${attr.accepted_at}) OR attribute_exists(${attr.rejected_at})`
        })
        return makeMembershipItem(item, request.username, request.org.id)
    }

    async putMember(memberId: string, org: Org, request: DDB.NonKeyType<MemberTable>, mode: "create" | "update" = "create") {
        const Membership = this.data.narrow(MemberSchema)
        const item = {
            pk: `U#${memberId}`,
            sk: `O#${org.id}`,
            invited_by: request.invited_by,
            invited_at: Date.now() / 1000,
            role: request.role ?? 'member',
            org: {
                id: org.id,
                title: org.title
            },
        } as const;
        const response = await Membership.put({
            item,
            condition({attr}) {
                if (mode === "create") {
                    return `attribute_not_exists(${attr.accepted_at}) OR attribute_exists(${attr.rejected_at})`
                }
                return undefined
            }
        })
        if (response.ConditionCheckFailed) return undefined
        return makeMembershipItem(item, memberId, org.id)
    }

    /**
     * Accept an unaccepted invite.
     */
    async acceptInvite(username: string, org: string) {
        const Membership = this.data.narrow(MemberSchema)
        const response = await Membership.update({
            key: {pk: `U#${username}`, sk: `O#${org}`},
            expression: ({attr, ref}) => ({
                set: `${attr.accepted_at} = ${ref('date')}`,
                remove: attr.rejected_at
            }),
            condition: ({attr, key}) =>
                `attribute_not_exists(${attr.accepted_at}) AND attribute_exists(${key.pk}) AND attribute_exists(${key.sk})`,
            return: "ALL_NEW"
        }, {date: Date.now() / 1000});

        if (response.ConditionCheckFailed) {
            return undefined
        } else {
            const invite = response.Attributes
            return makeMembershipItem(invite, username, org)
        }

    }

    /**
     * Reject an invitation.
     */
    async rejectInvite(username: string, org: string) {
        const Membership = this.data.narrow(MemberSchema)
        const response = await Membership.update({
            key: {pk: `U#${username}`, sk: `O#${org}`},
            expression: ({attr, ref}) => `SET ${attr.rejected_at} = ${ref('date')}`,
            condition: ({key}) =>
                `attribute_exists(${key.pk}) AND attribute_exists(${key.sk})`,
            return: "ALL_NEW"
        }, {date: Date.now() / 1000});
        if (response.ConditionCheckFailed)
            return undefined
        const invite = response.Attributes
        return makeMembershipItem(invite, username, org)
    }

    /**
     * Update membership record.
     */
    async updateMembership(username: string, org: string, request: { role: schemas.MemberRole }) {
        const Membership = this.data.narrow(MemberSchema)
        const values = {role: request.role,}
        const response = await Membership.update({
            key: {pk: `U#${username}`, sk: `O#${org}`},
            expression: ({attr, ref}) => {
                const updates = []

                if (values.role !== undefined)
                    updates.push(`${attr.role} = ${ref('role')}`)

                return {
                    set: updates
                }
            },
            condition: ({key}) =>
                `attribute_exists(${key.pk}) AND attribute_exists(${key.sk})`,
            return: "ALL_NEW"
        }, values);
        if (response.ConditionCheckFailed) return undefined
        return makeMembershipItem(response.Attributes, username, org)
    }

    /**
     * Fetch membership record.
     */
    async fetchMembership(username: string, org: string): Promise<MemberItem | undefined> {
        const Membership = this.data.narrow(MemberSchema)
        const {Item: item} = await Membership.get({key: {pk: `U#${username}`, sk: `O#${org}`}})
        if (item === undefined) return undefined
        return makeMembershipItem(item, username, org)
    }

    /**
     * Fetch member record.
     */
    async fetchUser(username: string): Promise<UserItem | undefined> {
        const User = this.data.narrow(UserSchema)
        const {Item: item} = await User.get({key: {pk: `U#${username}`, sk: `U`}})
        if (item === undefined) return undefined
        return {...item, pk: username}
    }

    /**
     * Create new non-persistent User item.
     * @param username - recipient user name
     */
    createUser(username: string): UserItem {
        return {pk: username}
    }

    async updateUser({pk, ...member}: UserItem): Promise<UserItem | undefined> {
        const User = this.data.narrow(UserSchema)
        const response = await User.update({
            key: {pk: `U#${pk}`, sk: 'U'},
            expression: ({attr, ref}) => ({
                set: {
                    [attr.walletId]: ref('walletId'),
                    [attr.mangopayUid]: ref('mangopayUid')
                }
            }),
            condition: ({attr, ref}) =>
                `
                attribute_not_exists(${attr.walletId}) OR ${attr.walletId} = ${ref('walletId')}
                AND
                attribute_not_exists(${attr.mangopayUid}) OR ${attr.mangopayUid} = ${ref('mangopayUid')}
                `,
            return: "ALL_NEW"
        }, {walletId: member.walletId ?? null, mangopayUid: member.mangopayUid ?? null});
        if (response.ConditionCheckFailed) return undefined
        return {
            ...response.Attributes,
            pk
        }
    }

    async removeUser(username: string): Promise<UserItem | undefined> {
        const User = this.data.narrow(UserSchema)
        const {Attributes: item} = await User.delete({
            key: {pk: `U#${username}`, sk: `U`},
            return: "ALL_OLD"
        })
        if (item === undefined) return undefined
        return {
            ...item,
            pk: username
        }
    }

    /**
     * Delete member record.
     */
    async removeMembership(username: string, org: string): Promise<MemberItem | undefined> {
        const Membership = this.data.narrow(MemberSchema)
        const {Attributes: item} = await Membership.delete({
            key: {pk: `U#${username}`, sk: `O#${org}`},
            return: "ALL_OLD"
        })
        if (item === undefined) return undefined
        return {
            ...item,
            id: username,
            orgId: org
        }
    }

    async organizations(startKey?: OrgKey): Promise<{ organizations: Org[]; next?: Key }> {
        const Org = this.inverse.narrow(OrgSchema)
        const {Items: orgs, LastEvaluatedKey: lastKey} = await Org.query({
            startKey,
            keyCondition: ({key, ref}) => `${key.sk} = ${ref('sk')}`
        }, {sk: "O"})
        return {
            next: lastKey,
            organizations: orgs.map(x => ({
                ...x,
                id: x.pk.substring(2)
            }))
        }
    }

    /**
     * Fetch organisation information.
     */
    async fetchOrg(orgId: string): Promise<Org | undefined> {
        const Org = this.data.narrow(OrgSchema)
        const {Item: item} = await Org.get({key: {pk: `O#${orgId}`, sk: `O`}})
        if (item === undefined) return undefined
        return {
            ...item,
            id: orgId
        }
    }

    async batchGetOrgs(ids: string[]): Promise<Org[]> {
        if (ids.length === 0) return []
        const Org = this.data.narrow(OrgSchema)
        const {Responses: orgs} = await Org.batchGet({
            keys: ids.map((oid) => ({pk: `O#${oid}`, sk: `O`}))
        })
        return orgs.map(({pk, sk, ...org}) => ({
            ...org,
            id: pk.substring(2)
        }))
    }

    /**
     * Fetch organisation members.
     */
    async orgMembers(orgId: string, startKey?: MemberKey, ids?: string[]): Promise<{
        lastKey?: MemberKey,
        members: MemberItem[]
    }> {
        const orgPk = `O#${orgId}`;
        const Members = this.inverse.narrow(MemberSchema)
        let {Items: members, LastEvaluatedKey: lastKey} = await Members.query({
            startKey,
            keyCondition: ({key, ref}) => `${key.sk} = ${ref('orgPk')} AND begins_with(${key.pk}, ${ref('prefix')})`
        }, {orgPk, prefix: 'U#'})
        if (ids !== undefined) {
            members = members.filter(x => _.includes(ids, x.pk.substring(2)))
        }
        return {
            lastKey: lastKey,
            members: members.map(x => makeMembershipItem(x))
        }
    }

    async createOrg(request: OrgRequest): Promise<Org> {
        const Org = this.data.narrow(OrgSchema)
        const orgId = uuid()
        const item = {
            pk: `O#${orgId}`,
            sk: `O`,
            title: request.title,
            created_at: Date.now() / 1000,
            tip_settings: {
                type: "individual",
            },
        } satisfies DDB.ItemType<OrgTable>;
        await Org.put({item})
        return {
            ...item,
            id: orgId
        }
    }

    async removeOrg(orgId: string) {
        const Org = this.data.narrow(OrgSchema)
        const {Attributes: item} = await Org.delete({
            key: {pk: `O#${orgId}`, sk: `O`},
            return: "ALL_OLD"
        })
        if (item === undefined) return undefined
        return {
            ...item,
            pk: orgId
        }
    }

    async location(orgId: string, locId: string): Promise<LocationItem | undefined> {
        const Location = this.data.narrow(LocationSchema)
        const {Item: item} = await Location.get({key: {pk: `O#${orgId}`, sk: `L#${locId}`}})
        if (item === undefined) return undefined
        return {
            ...item,
            pk: orgId,
            sk: locId
        }
    }

    async queryOrgMembers(orgId: string, ids: string[]) {
        if (ids.length === 0) return []
        const User = this.inverse.narrow(MemberSchema)
        const {Items: members} = await User.query({
            keyCondition({key, ref}) {
                return `${key.sk} = ${ref('orgId')} AND begins_with(${key.pk}, ${ref('prefix')})`
            },
            filter({key, ref}) {
                return `contains(${ref('ids')}, ${key.pk})`
            }
        }, {orgId, prefix: 'U#', ids})
        return members.map(x => makeMembershipItem(x))
    }

    async locationMembers(orgId: string, locId: string): Promise<string[] | undefined> {
        const location = await this.location(orgId, locId)
        if (location === undefined) return undefined
        return location.users !== undefined ? Array.from(location.users.values()) : []
    }

    async batchGetLocations(locationIds: { orgId: string, locationId: string }[]): Promise<LocationItem[]> {
        if (locationIds.length === 0) return []
        const Location = this.data.narrow(LocationSchema)
        const {Responses: locations} = await Location.batchGet({
            keys: locationIds.map(function ({orgId, locationId}) {
                return {pk: `O#${orgId}`, sk: `L#${locationId}`}
            })
        })
        if (locations === undefined) return []
        return locations.map(x => ({
            ...x,
            pk: x.pk.substring(2 /*O#.length*/),
            sk: x.sk.substring(2 /*L#.length*/)
        }))
    }

    async locations(orgId: string, query: {
        startKey: DDB.KeyType<LocationTable>,
        archived: boolean,
        title?: string
    }): Promise<{ lastKey?: DDB.KeyType<LocationTable>, data: LocationItem[] }> {
        const Location = this.data.narrow(LocationSchema)
        const orgPk = `O#${orgId}`;
        const filterArchived = !query.archived
        const {Items: locations, LastEvaluatedKey: lastKey} = await Location.query({
            startKey: query.startKey,
            keyCondition: ({key, ref}) => `${key.pk} = ${ref('orgPk')} AND begins_with(${key.sk}, ${ref('prefix')})`,
            filter({attr, ref}) {
                let filter = []
                if (filterArchived) {
                    filter.push(`(${attr.deleted} = ${ref.val(false)} OR attribute_not_exists(${attr.deleted}))`)
                }
                if (query.title !== undefined) {
                    filter.push(`contains(${attr.lowercase_title}, ${ref('lowercase_title')})`)
                }
                return filter.join(' AND ')
            }
        }, {orgPk, prefix: 'L#', lowercase_title: query.title?.toLocaleLowerCase()});

        return {
            lastKey: lastKey,
            data: locations.map(x => ({
                ...x,
                pk: x.pk.substring(2 /*O#.length*/),
                sk: x.sk.substring(2 /*L#.length*/)
            }))
        }
    }

    async updateLocation(orgId: string, request: schemas.LocationRequest, locId?: string, mode: "create" | "update" = "create") {
        const Location = this.data.narrow(LocationSchema)
        const locationId = locId ?? uuid();
        const key = {pk: `O#${orgId}`, sk: `L#${locationId}`} as const;
        const item = {
            ...request,
            lowercase_title: request.title?.toLocaleLowerCase(),
            updated_at: Date.now() / 1000,
            deleted: false
        } as const;
        const response = await Location.update({
            key,
            expression({attr, ref}) {
                const exp = {
                    set: {
                        [attr.title]: ref('title'),
                        [attr.email]: ref('email'),
                        [attr.phone]: ref('phone'),
                        [attr.address]: ref('address'),
                        [attr.goal.toString()]: ref('goal'),
                        [attr.lowercase_title]: ref('lowercase_title'),
                        [`${attr.image}`]: ref('image'),
                        [attr.created_at]: `if_not_exists(${attr.created_at}, ${ref('updated_at')})`,
                        [attr.updated_at]: ref('updated_at'),
                        [attr.deleted]: ref('deleted'),
                    }
                };
                if (mode === 'create') exp.set[`${attr.tip_settings}`] = ref.val({})
                return exp
            },
            condition: function ({key}) {
                return mode === "update" ? `attribute_exists(${key.pk}) AND attribute_exists(${key.sk})` : undefined
            },
            return: "ALL_NEW"
        }, item);

        function makeLocation(x: LocationItem) {
            return {
                ...x,
                pk: orgId,
                sk: locationId
            }
        }

        if (response.ConditionCheckFailed) return undefined

        return makeLocation(response.Attributes)
    }

    async archiveLocation(orgId: string, locId: string) {
        const Location = this.data.narrow(LocationSchema)
        const response = await Location.update({
            key: {pk: `O#${orgId}`, sk: `L#${locId}`},
            expression: ({attr, ref}) => ({
                set: {
                    [attr.deleted]: ref.val(true),
                    [attr.updated_at]: ref('updated_at'),
                }
            }),
            condition: ({key}) => `attribute_exists(${key.pk}) AND attribute_exists(${key.pk})`,
            return: "ALL_NEW"
        }, {updated_at: Date.now() / 1000})

        if (response.ConditionCheckFailed) {
            return undefined
        }
        const item = response.Attributes
        return {
            ...item,
            pk: orgId,
            sk: locId
        }
    }

    async removeLocation(orgId: string, locId: string) {
        const Location = this.data.narrow(LocationSchema)
        const {Attributes: item} = await Location.delete({
            key: {pk: `O#${orgId}`, sk: `L#${locId}`},
            return: "ALL_OLD"
        })
        if (item === undefined) return undefined
        return {
            ...item,
            pk: orgId,
            sk: locId
        }
    }

    async modifyUserLocation(orgId: string, locationId: string, userId: string, action: 'add' | 'delete') {
        const Location = this.data.narrow(LocationSchema)
        const Membership = this.data.narrow(MemberSchema)
        const locationKey = {pk: `O#${orgId}`, sk: `L#${locationId}`} as const;
        const userKey = {pk: `U#${userId}`, sk: `O#${orgId}`} as const;

        const tx = this.db.transactWrite()
        Location.with(tx).update({
            key: locationKey,
            expression: ({attr, ref}) => ({
                [action]: `${attr.users} ${ref('userId')}`
            }),
            //Limit location users to 100 to guarantee we can batch get them in one query.
            condition: ({attr, key, ref}) =>
                `(
                           ${ref('action')} = ${ref.val('delete')} 
                        or contains(${attr.users}, ${ref('userId')}) 
                        or size(${attr.users}) < ${ref('limit')}
                        or attribute_not_exists(${attr.users})
                     ) 
                    and attribute_exists(${key.pk}) 
                    and attribute_exists(${key.sk})
                    `
        }, {userId: new Set([userId]), action, limit: 100})
        Membership.with(tx).update({
            key: userKey,
            expression: ({attr, ref}) => ({
                [action]: `${attr.locations} ${ref('locationId')}`
            }),
            condition: ({attr, key, ref}) =>
                `(
                           ${ref.val(action)} = ${ref.val('delete')} 
                        or contains(${attr.locations},  ${ref('locationId')}) 
                        or size(${attr.locations}) < ${ref('limit')}
                        or attribute_not_exists(${attr.locations})
                    ) 
                    and attribute_exists(${key.pk}) 
                    and attribute_exists(${key.sk})`
        }, {locationId: new Set([locationId]), action, limit: 10})
        await tx.exec()
        return {
            pk: userId,
            sk: locationId
        }
    }

    async fetchTipSettings(query: schemas.TipSettingsQuery): Promise<{
        org: Org | undefined,
        location: LocationItem | undefined,
        recipient: UserItem | undefined
    }> {
        const batch = this.db.batchGet()
        const keys: DDB.KeyType<DataTable>[] = [
            {pk: `O#${query.org}`, sk: `O`} satisfies DDB.KeyType<OrgTable>,
            {pk: `O#${query.org}`, sk: `L#${query.location}`} satisfies DDB.KeyType<LocationTable>
        ]
        if (query.recipient !== undefined) {
            keys.push({pk: `U#${query.recipient}`, sk: `U`} satisfies DDB.KeyType<UsersTable>)
        }
        this.data.with(batch).get({keys: keys})
        const response = await batch.exec()
        if (response.UnprocessedKeys !== undefined) throw internalError().withContext("fetchTipSettings", {
            query,
            response
        })
        const [org, location, recipient] = response.Responses[this.data.name] as [DDB.ItemType<OrgTable>?, DDB.ItemType<LocationTable>?, DDB.ItemType<UsersTable>?]

        return {
            org: org !== undefined ? {
                ...org,
                id: query.org
            } : undefined,
            location: location !== undefined ? {
                ...location,
                pk: query.org,
                sk: query.location,
            } : undefined,
            recipient: query.recipient !== undefined && recipient !== undefined ? {
                ...recipient,
                pk: query.recipient
            } : undefined
        }
    }
}
