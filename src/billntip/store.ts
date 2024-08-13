import * as ddb from "@app/dynamodb";
import {AttributeValue, DynamoDB} from "@aws-sdk/client-dynamodb";
import {unmarshall} from "@aws-sdk/util-dynamodb";
import _ from "lodash";
import {Schema, TableAttributes, TableSchema} from "@app/dynamodb";
import {uuid} from "short-uuid";
import {internalError} from "@app/lambda";
import {MemberRole} from "@src/billntip/schemas";


// pk               sk              attributes
// Users
// U#<username>     M               mangopayUid, walletId
// U#<username>     O#<name>        role, invited_by, invited_at, accepted_at, rejected_at
// U#<name>         L#<loc id>      org_id, created_at

// Organisations
// O#<name>         info            title, created_at
// O#<name>         U#<username>    same as U:<username>, O#<name>

//Locations
// O#<name>         L#<loc id>      title, created_at, updated_at, image_url, deleted


const UserKey = {
    pk: ddb.Type.String as `U#${string}`,
    sk: ddb.Type.String as `M`,
} as const

const UserAttributes = {
    mangopayUid: ddb.Type.String,
    walletId: ddb.Type.String
} as const

export type UsersTable = TableSchema<typeof UserKey, typeof UserAttributes>;
export type UserItem = TableAttributes<UsersTable> & { pk: string }

const MemberhipKey = {
    pk: ddb.Type.String as `U#${string}`,
    sk: ddb.Type.String as `O#${string}`,
} as const

const MembershipAttributes = {
    role: ddb.Type.String,
    invited_by: ddb.Type.String,
    invited_at: ddb.Type.Number,
    accepted_at: ddb.Type.Number,
    rejected_at: ddb.Type.Number,
} as const

type MembershipsTable = TableSchema<typeof MemberhipKey, typeof MembershipAttributes>;
export type MembershipItem = TableAttributes<MembershipsTable> & { pk: string, sk: string }

const OrgKey = {
    pk: ddb.Type.String as `O#${string}`,
    sk: ddb.Type.String as `info` | `U${string}`,
} as const

type OrgKey = Schema<typeof OrgKey>

const OrgAttributes = {
    //info attributes
    title: ddb.Type.String,
    created_at: ddb.Type.Number
} as const

type OrgsTable = TableSchema<typeof OrgKey, typeof OrgAttributes>;
export type Org = TableAttributes<OrgsTable> & { pk: string }

export interface OrgRequest {
    title: string
}

const OrgLocationKey = {
    pk: ddb.Type.String as `O#${string}`,
    sk: ddb.Type.String as `L#${string}`
} as const
type OrgLocationKey = Schema<typeof OrgLocationKey>
const OrgLocationAttributes = {
    title: ddb.Type.String,
    lowercase_title: ddb.Type.String,
    created_at: ddb.Type.Number,
    updated_at: ddb.Type.Number,
    image_url: ddb.Type.String,
    deleted: ddb.Type.Boolean
} as const
type OrgLocationsTable = TableSchema<typeof OrgLocationKey, typeof OrgLocationAttributes>;
export type OrgLocation = TableAttributes<OrgLocationsTable> & { pk: string, sk: string }

const UserLocationKey = {
    pk: ddb.Type.String as `U#${string}`,
    sk: ddb.Type.String as `L#${string}`
} as const
type UserLocationKey = Schema<typeof UserLocationKey>
const UserLocationAttributes = {
    org_id: ddb.Type.String,
    created_at: ddb.Type.Number,
} as const
type UserLocationTable = TableSchema<typeof UserLocationKey, typeof UserLocationAttributes>
export type UserLocation = TableAttributes<UserLocationTable> & { pk: string, sk: string }

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
    accepted?: boolean,
    rejected?: boolean
}

function makeMembershipItem(invite: Record<string, AttributeValue>, username?: string, org?: string): MembershipItem {
    const record = unmarshall(invite);
    //Aug 2024: This is a migration from old invited_by format to the new one. Old format had some info about invitee, new format only has invitee id.
    if (record.invited_by != null && typeof record.invited_by === "object") {
        record.invited_by = record.invited_by.username
    }
    const pk = username ?? record.pk.substring(2/*U#.length*/)
    const sk = org ?? record.sk.substring(2/*O#.length*/)
    return {
        ...record,
        pk,
        sk
    };
}

export default class Store {
    db: DynamoDB;
    table: string;
    membership: MembershipsTable;
    members: UsersTable;
    _org: OrgsTable;
    _orgLocations: OrgLocationsTable;
    _userLocations: UserLocationTable;

    constructor(options: StoreOptions) {
        this.db = options.db ?? new DynamoDB()
        this.table = options.table
        this.membership = ddb.table(this.table, MemberhipKey, MembershipAttributes)
        this.members = ddb.table(this.table, UserKey, UserAttributes)
        this._org = ddb.table(this.table, OrgKey, OrgAttributes)
        this._orgLocations = ddb.table(this.table, OrgLocationKey, OrgLocationAttributes)
        this._userLocations = ddb.table(this.table, UserLocationKey, UserLocationAttributes)
    }

    async memberships(username: string, filters: MembershipFilters = {
        accepted: false,
        rejected: false
    }): Promise<MembershipItem[]> {
        const attributes = {
            accepted_at: filters.accepted,
            rejected_at: filters.rejected
        } as const
        const pk = `U#${username}`
        const pendingInvites = ddb.query(this.membership, {
            values: {pk, prefix: "O#"},
            keyCondition: ({key, ref}) =>
                `${key.pk} = ${ref('pk')} AND begins_with(${key.sk}, ${ref('prefix')})`,
            filter: ({attr}) => Object
                .entries(attributes)
                .filter(([_1, value]) => value !== undefined)
                .map(([key, value]) => {
                    const attribute = key as keyof typeof attributes
                    return value ? `attribute_exists(${attr[attribute]})` : `attribute_not_exists(${attr[attribute]})`
                })
                .join(' AND ')
        })
        const {Items: invites} = await this.db.query(pendingInvites)
        return _.map(invites, x => makeMembershipItem(x))
    }

    /**
     * Create new invite if another does not exist or was rejected.
     */
    async inviteToOrg(request: InviteRequest): Promise<MembershipItem> {
        const key = {pk: `U#${request.username}`, sk: `O#${request.org.id}`} as const;
        const item = {
            invited_by: request.invited_by,
            invited_at: Date.now() / 1000,
            role: request.role ?? 'member',
            org: {
                id: request.org.id,
                title: request.org.title
            },
        };
        const {Attributes: invite} = await this.db.putItem(ddb.put(this.membership, {
            key,
            item,
            condition: ({attr}) => `attribute_not_exists(${attr.accepted_at}) OR attribute_exists(${attr.rejected_at})`,
        }))
        return makeMembershipItem(invite ?? {}, request.username, request.org.id)
    }

    /**
     * Accept an unaccepted invite.
     */
    async acceptInvite(username: string, org: string) {
        const item = ddb.update(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
            values: {date: Date.now() / 1000},
            expression: ({attr, ref}) => ({
                set: `${attr.accepted_at} = ${ref('date')}`,
                remove: attr.rejected_at
            }),
            condition: ({attr, key}) =>
                `attribute_not_exists(${attr.accepted_at}) AND attribute_exists(${key.pk}) AND attribute_exists(${key.sk})`,
            return: "ALL_NEW"
        });
        const {Attributes: invite} = await this.db.updateItem(item)
        if (invite === undefined) throw internalError("Unexpected error accepting invite")
        return makeMembershipItem(invite, username, org)
    }

    /**
     * Reject an invitation.
     */
    async rejectInvite(username: string, org: string) {
        const item = ddb.update(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
            values: {date: Date.now() / 1000},
            expression: ({attr, ref}) => `SET ${attr.rejected_at} = ${ref('date')}`,
            condition: ({key}) =>
                `attribute_exists(${key.pk}) AND attribute_exists(${key.sk})`,
            return: "ALL_NEW"
        });
        const {Attributes: invite} = await this.db.updateItem(item)
        if (invite === undefined) throw internalError("Unexpected error rejecting invite")
        return makeMembershipItem(invite, username, org)
    }

    /**
     * Update membership record.
     */
    async updateMembership(username: string, org: string, request: { role: MemberRole }): Promise<MembershipItem> {

        const values = {
            role: request.role,
        }

        const item = ddb.update(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
            values,
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
        });
        const {Attributes: invite} = await this.db.updateItem(item)
        if (invite === undefined) throw internalError("Unexpected error updating membership")
        return makeMembershipItem(invite, username, org)
    }

    /**
     * Fetch membership record.
     */
    async fetchMembership(username: string, org: string): Promise<MembershipItem | undefined> {
        const {Item: item} = await this.db.getItem(ddb.get(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
        }))
        if (item === undefined) return undefined
        return makeMembershipItem(item, username, org)
    }

    /**
     * Fetch member record.
     */
    async fetchUser(username: string): Promise<UserItem | undefined> {
        const {Item: item} = await this.db.getItem(ddb.get(this.members, {
            key: {pk: `U#${username}`, sk: `M`},
        }))
        if (item === undefined) return undefined
        return {
            ...unmarshall(item),
            pk: username
        }
    }

    /**
     * Create new non-persistent Member item.
     * @param username - member username
     */
    createMember(username: string): UserItem {
        return {
            pk: username
        }
    }

    async updateMember({pk, ...member}: UserItem) {

        const item = ddb.update(this.members, {
            key: {pk: `U#${pk}`, sk: 'M'},
            values: {
                walletId: member.walletId ?? null,
                mangopayUid: member.mangopayUid ?? null
            },
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
        });
        const {Attributes: invite} = await this.db.updateItem(item)
        if (invite === undefined) throw internalError("Unexpected error updating membership")
        return {
            ...unmarshall(invite),
            pk
        }
    }

    async removeMember(username: string) {
        const {Attributes: item} = await this.db.deleteItem(ddb.deleteItem(this.members, {
            key: {pk: `U#${username}`, sk: `M`},
            return: "ALL_OLD"
        }))
        if (item === undefined) return undefined
        return {
            ...unmarshall(item),
            pk: username
        }
    }

    /**
     * Delete member record.
     */
    async removeMembership(username: string, org: string): Promise<MembershipItem | undefined> {
        const {Attributes: item} = await this.db.deleteItem(ddb.deleteItem(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
            return: "ALL_OLD"
        }))
        if (item === undefined) return undefined
        return {
            ...unmarshall(item),
            pk: username, sk: org
        }
    }

    /**
     * Fetch organisation information.
     */
    async fetchOrg(orgId: string): Promise<Org | undefined> {
        const {Item: item} = await this.db.getItem(ddb.get(this._org, {
            key: {pk: `O#${orgId}`, sk: `info`},
        }))
        if (item === undefined) return undefined
        return {
            ...unmarshall(item),
            pk: orgId
        }
    }

    async batchFetchOrgs(ids: string[]): Promise<Org[]> {

        if (ids.length === 0) return []

        const batchGet = ddb.batchGet()
            .add(this._org, {
                keys: ids.map((oid) => ({pk: `O#${oid}`, sk: `info`} as OrgKey))
            })
        const {Responses: responses} = await this.db.batchGetItem(batchGet.input())
        const orgs = responses?.[this._org.name]
        if (orgs === undefined) return []
        return orgs.map(({pk, sk, ...loc}) => ({
            ...unmarshall(loc) as Org,
            pk: pk.S!.substring(2)
        }))
    }

    /**
     * Fetch organisation members.
     */
    async orgMembers(orgId: string, startKey?: OrgKey): Promise<{
        lastKey?: OrgKey,
        members: MembershipItem[]
    }> {
        const orgPk = `O#${orgId}`;
        const membersQuery = ddb.query(this._org, {
            indexName: "inverse",
            values: {orgPk, prefix: 'U#'},
            keyCondition: ({key, ref}) =>
                `${key.sk} = ${ref('orgPk')} AND begins_with(${key.pk}, ${ref('prefix')})`,
            exclusiveStartKey: startKey
        })
        const {Items: members, LastEvaluatedKey: lastKey} = await this.db.query(membersQuery)
        if (members === undefined || members.length === 0) return {members: []}
        return {
            lastKey: lastKey !== undefined ? unmarshall(lastKey) as OrgKey : lastKey,
            members: members.map(x => makeMembershipItem(x))
        }
    }

    async createOrg(request: OrgRequest) {
        const orgId = uuid()
        const key = {pk: `O#${orgId}`, sk: `info`} as const;
        const item = {
            title: request.title,
            created_at: Date.now() / 1000,
        } as const;
        await this.db.putItem(ddb.put(this._org, {key, item}))
        return {
            pk: orgId,
            ...item
        }
    }

    async removeOrg(orgId: string) {
        const {Attributes: item} = await this.db.deleteItem(ddb.deleteItem(this._org, {
            key: {pk: `O#${orgId}`, sk: `info`},
            return: "ALL_OLD"
        }))
        if (item === undefined) return undefined
        return {
            ...unmarshall(item),
            pk: orgId
        }
    }

    async fetchLocation(orgId: string, locId: string): Promise<OrgLocation | undefined> {
        const {Item: item} = await this.db.getItem(ddb.get(this._orgLocations, {
            key: {pk: `O#${orgId}`, sk: `L#${locId}`},
        }))
        if (item === undefined) return undefined
        return {
            ...unmarshall(item),
            pk: orgId,
            sk: locId
        }
    }

    async userLocations(username: string) {
        let locations = []
        const pk = `U#${username}`;
        const ddbQuery = ddb.query(this._userLocations, {
            values: {pk, prefix: 'L#'},
            keyCondition: ({key, ref}) =>
                `${key.pk} = ${ref('pk')} AND begins_with(${key.sk}, ${ref('prefix')})`
        });
        do {
            const {Items: items, LastEvaluatedKey: lastKey} = await this.db.query(ddbQuery)
            ddbQuery.ExclusiveStartKey = lastKey
            if (items !== undefined) {
                locations.push(...items.map(function (loc) {
                        return {
                            ...unmarshall(loc),
                            pk: username,
                            sk: loc['sk'].S?.substring(2)
                        } as UserLocation
                    })
                )
            }
        } while (ddbQuery.ExclusiveStartKey !== undefined)
        return locations
    }

    async batchGetLocations(locations: UserLocation[]) {

        if (locations.length === 0) return []

        const batchGet = ddb.batchGet()
            .add(this._orgLocations, {
                keys: locations.map(({sk, org_id}) => ({pk: `O#${org_id}`, sk: `L#${sk}`} as OrgLocationKey))
            })
        const {Responses: responses} = await this.db.batchGetItem(batchGet.input())
        const orgLocations = responses?.[this._orgLocations.name]
        if (orgLocations === undefined) return []
        return orgLocations.map(({pk, sk, ...loc}) => ({
            ...unmarshall(loc) as OrgLocation,
            pk: pk.S!.substring(2),
            sk: sk.S!.substring(2)
        }))
    }

    async locations(orgId: string, query: { startKey: OrgLocationKey, archived: boolean, title?: string }): Promise<{
        lastKey?: OrgLocationKey,
        data: OrgLocation[]
    }> {
        const orgPk = `O#${orgId}`;
        const filterArchived = !query.archived
        const ddbQuery = ddb.query(this._orgLocations, {
            values: {orgPk, prefix: 'L#', archived: query.archived, lowercase_title: query.title?.toLocaleLowerCase()},
            keyCondition: ({key, ref}) =>
                `${key.pk} = ${ref('orgPk')} AND begins_with(${key.sk}, ${ref('prefix')})`,
            filter({attr, ref}) {
                let filter = []
                if (filterArchived) {
                    filter.push(`(${attr.deleted} = ${ref.val(false)} OR attribute_not_exists(${attr.deleted}))`)
                }
                if (query.title !== undefined) {
                    filter.push(`contains(${attr.lowercase_title}, ${ref('lowercase_title')})`)
                }
                return filter.join(' AND ')
            },
            exclusiveStartKey: query.startKey
        });

        const {Items: locations, LastEvaluatedKey: lastKey} = await this.db.query(ddbQuery)

        if (locations === undefined) return {data: []}

        return {
            lastKey: lastKey !== undefined ? unmarshall(lastKey) as OrgLocationKey : lastKey,
            data: locations.map(x => unmarshall(x)).map(x => ({
                ...x,
                pk: x.pk.substring(2 /*O#.length*/),
                sk: x.sk.substring(2 /*L#.length*/)
            }))
        }
    }

    async updateLocation(orgId: string, request: TableAttributes<OrgLocationsTable>, locId?: string): Promise<OrgLocation | undefined> {
        const locationId = locId ?? uuid();
        const key = {pk: `O#${orgId}`, sk: `L#${locationId}`} as const;
        const item = {
            ...request,
            lowercase_title: request.title?.toLocaleLowerCase(),
            updated_at: Date.now() / 1000,
            deleted: false,
        } as const;
        try {
            const query = ddb.update(this._orgLocations, {
                key,
                values: item,
                expression: ({attr, ref}) => ({
                    set: {
                        [attr.title]: ref('title'),
                        [attr.lowercase_title]: ref('lowercase_title'),
                        [attr.image_url]: ref('image_url'),
                        [attr.created_at]: `if_not_exists(${attr.created_at}, ${ref('updated_at')})`,
                        [attr.updated_at]: ref('updated_at'),
                        [attr.deleted]: ref('deleted'),
                    }
                }),
                condition: function ({key}) {
                    return locId !== undefined ? `attribute_exists(${key.pk}) AND attribute_exists(${key.sk})` : undefined
                },
                return: "ALL_NEW"
            });
            const {Attributes: attrs} = await this.db.updateItem(query)
            return {
                ...(attrs !== undefined ? unmarshall(attrs) : item),
                pk: orgId,
                sk: locationId
            }
        } catch (e: any) {
            if (e.name === 'ConditionalCheckFailedException') {
                return undefined
            }
            throw e
        }
    }

    async archiveLocation(orgId: string, locId: string) {
        const key = {pk: `O#${orgId}`, sk: `L#${locId}`} as const;
        try {
            const {Attributes: item} = await this.db.updateItem(ddb.update(this._orgLocations, {
                key,
                values: {
                    updated_at: Date.now() / 1000,
                },
                expression: ({attr, ref}) => ({
                    set: {
                        [attr.deleted]: ref.val(true),
                        [attr.updated_at]: ref('updated_at'),
                    }
                }),
                condition: ({key}) => `attribute_exists(${key.pk}) AND attribute_exists(${key.pk})`,
                return: "ALL_NEW"
            }))
            if (item === undefined) return undefined
            return {
                ...unmarshall(item),
                pk: orgId,
                sk: locId
            }
        } catch (e: any) {
            if (e.name === 'ConditionalCheckFailedException') {
                return undefined
            }
            throw e
        }
    }

    async removeLocation(orgId: string, locId: string) {
        const {Attributes: item} = await this.db.deleteItem(ddb.deleteItem(this._orgLocations, {
            key: {pk: `O#${orgId}`, sk: `L#${locId}`},
            return: "ALL_OLD"
        }))
        if (item === undefined) return undefined
        return {
            ...unmarshall(item),
            pk: orgId,
            sk: locId
        }
    }

    async assignUserToLocation(orgId: string, locId: string, userId: string): Promise<UserLocation> {
        const key = {pk: `U#${userId}`, sk: `L#${locId}`} as const;
        const item = {
            created_at: Date.now() / 1000,
            orgId
        } as const;
        await this.db.updateItem(ddb.update(this._userLocations, {
            key,
            values: item,
            expression: ({attr, ref}) => ({
                set: {
                    [attr.org_id]: ref('orgId'),
                    [attr.created_at]: `if_not_exists(${attr.created_at}, ${ref('created_at')})`,
                }
            })
        }))
        return {
            pk: userId,
            sk: locId,
            ...item
        }
    }

    async removeUserFromLocation(locId: string, userId: string): Promise<UserLocation | undefined> {
        const key = {pk: `U#${userId}`, sk: `L#${locId}`} as const;
        const {Attributes: item} = await this.db.deleteItem(ddb.deleteItem(this._userLocations, {
            key,
            return: "ALL_OLD"
        }))
        if (item === undefined) return undefined
        return {
            ...unmarshall(item),
            pk: userId,
            sk: locId
        }
    }

}
