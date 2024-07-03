import * as ddb from "@app/dynamodb";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {unmarshall} from "@aws-sdk/util-dynamodb";
import _ from "lodash";
import {Schema, TableItem, TableSchema} from "@app/dynamodb";
import {uuid} from "short-uuid";
import {internalError} from "@app/lambda";

const MemberKey = {
    pk: ddb.Type.String as `U#${string}`,
    sk: ddb.Type.String as `M`,
} as const

const MemberAttributes = {
    mangopayUid: ddb.Type.String,
    walletId: ddb.Type.String
} as const

type MemberTable = TableSchema<typeof MemberKey, typeof MemberAttributes>;
export type MemberItem = TableItem<MemberTable>

const MemberhipKey = {
    pk: ddb.Type.String as `U#${string}`,
    sk: ddb.Type.String as `O#${string}`,
} as const

const MembershipAttributes = {
    org: {
        id: ddb.Type.String,
        title: ddb.Type.String
    },
    role: ddb.Type.String,
    invited_by: {
        username: ddb.Type.String,
        first_name: ddb.Type.String,
        last_name: ddb.Type.String,
        email: ddb.Type.String,
    },
    invited_at: ddb.Type.Number,
    accepted_at: ddb.Type.Number,
    rejected_at: ddb.Type.Number,
} as const

type MembershipsTable = TableSchema<typeof MemberhipKey, typeof MembershipAttributes>;
export type MembershipItem = TableItem<MembershipsTable>

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

export type OrgsTable = TableSchema<typeof OrgKey, typeof OrgAttributes>;
export type Org = TableItem<OrgsTable>

export interface OrgRequest {
    title: string
}

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
    invited_by: {
        username: string,
        first_name: string,
        last_name: string,
        email: string,
    },
    role?: string
}

export interface UpdateMembershipRequest {
    org?: {
        title: string
    },
    invited_by?: {
        username?: string,
        first_name?: string,
        last_name?: string,
        email?: string,
    },
    role?: string
}

export interface MembershipFilters {
    accepted?: boolean,
    rejected?: boolean
}

export default class Store {
    db: DynamoDB;
    table: string;
    membership: MembershipsTable;
    members: MemberTable;
    orgs: OrgsTable;

    constructor(options: StoreOptions) {
        this.db = options.db ?? new DynamoDB()
        this.table = options.table
        this.membership = ddb.table(this.table, MemberhipKey, MembershipAttributes)
        this.members = ddb.table(this.table, MemberKey, MemberAttributes)
        this.orgs = ddb.table(this.table, OrgKey, OrgAttributes)
    }

    async memberships(username: string, filters: MembershipFilters = {
        accepted: false,
        rejected: false
    }) {
        const attributes = {
            accepted_at: filters.accepted,
            rejected_at: filters.rejected
        } as const
        const pk = `U#${username}`
        const pendingInvites = ddb.query(this.membership, {
            keyCondition: ({key, val}) =>
                `${key.pk} = ${val(pk)} AND begins_with(${key.sk}, ${val('O#')})`,
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
        return _.map(invites, x => unmarshall(x)) as MembershipItem[]
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
        await this.db.putItem(ddb.put(this.membership, {
            key,
            item,
            condition: ({attr}) => `attribute_not_exists(${attr.accepted_at}) OR attribute_exists(${attr.rejected_at})`,
        }))
        return {
            ...key, ...item
        }
    }

    /**
     * Accept an unaccepted invite.
     */
    async acceptInvite(username: string, org: string) {
        const item = ddb.update(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
            expression: ({attr, val}) => ({
                set: `${attr.accepted_at} = ${val(Date.now() / 1000)}`,
                remove: attr.rejected_at
            }),
            condition: ({attr, key}) =>
                `attribute_not_exists(${attr.accepted_at}) AND attribute_exists(${key.pk}) AND attribute_exists(${key.sk})`,
            return: "ALL_NEW"
        });
        const {Attributes: invite} = await this.db.updateItem(item)
        if (invite === undefined) throw internalError("Unexpected error accepting invite")
        return unmarshall(invite) as MembershipItem
    }

    /**
     * Reject an invite.
     */
    async rejectInvite(username: string, org: string) {
        const item = ddb.update(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
            expression: ({attr, val}) => `SET ${attr.rejected_at} = ${val(Date.now() / 1000)}`,
            condition: ({key}) =>
                `attribute_exists(${key.pk}) AND attribute_exists(${key.sk})`,
            return: "ALL_NEW"
        });
        const {Attributes: invite} = await this.db.updateItem(item)
        if (invite === undefined) throw internalError("Unexpected error rejecting invite")
        return unmarshall(invite) as MembershipItem
    }

    /**
     * Update membership record.
     */
    async updateMembership(username: string, org: string, request: UpdateMembershipRequest) {
        const item = ddb.update(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
            expression: ({attr, val}) => {
                const updates = []

                const title = request.org?.title
                if (title !== undefined)
                    updates.push(`${attr.org.title} = ${val(title)}`)

                const firstName = request.invited_by?.first_name
                if (firstName !== undefined)
                    updates.push(`${attr.invited_by.first_name} = ${val(firstName)}`)

                const lastName = request.invited_by?.last_name
                if (lastName !== undefined)
                    updates.push(`${attr.invited_by.last_name} = ${val(lastName)}`)

                const email = request.invited_by?.email
                if (email !== undefined)
                    updates.push(`${attr.invited_by.email} = ${val(email)}`)

                const role = request.role
                if (role !== undefined)
                    updates.push(`${attr.role} = ${val(role)}`)

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
        return unmarshall(invite) as MembershipItem
    }

    /**
     * Fetch membership record.
     */
    async fetchMembership(username: string, org: string) {
        const {Item: item} = await this.db.getItem(ddb.get(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
        }))
        if (item === undefined) return undefined
        return unmarshall(item) as MembershipItem
    }

    /**
     * Fetch member record.
     */
    async fetchMember(username: string) {
        const {Item: item} = await this.db.getItem(ddb.get(this.members, {
            key: {pk: `U#${username}`, sk: `M`},
        }))
        if (item === undefined) return undefined
        return unmarshall(item) as MemberItem
    }

    /**
     * Create new non-persistent Member item.
     * @param username - member username
     */
    createMember(username: string): MemberItem {
        return {
            pk: `U#${username}`, sk: 'M'
        }
    }

    async updateMember({pk, sk, ...member}: MemberItem) {
        const item = ddb.update(this.members, {
            key: {pk, sk},
            values: member,
            expression: ({attr, val}) => ({
                set: {
                    [attr.walletId]: val.walletId,
                    [attr.mangopayUid]: val.mangopayUid
                }
            }),
            condition: ({attr, val}) =>
                `
                attribute_not_exists(${attr.walletId}) OR ${attr.walletId} = ${val.walletId}
                AND
                attribute_not_exists(${attr.mangopayUid}) OR ${attr.mangopayUid} = ${val.mangopayUid}
                `,
            return: "ALL_NEW"
        });
        const {Attributes: invite} = await this.db.updateItem(item)
        if (invite === undefined) throw internalError("Unexpected error updating membership")
        return unmarshall(invite) as MembershipItem
    }

    async removeMember(username: string) {
        const {Attributes: item} = await this.db.deleteItem(ddb.deleteItem(this.members, {
            key: {pk: `U#${username}`, sk: `M`},
            return: "ALL_OLD"
        }))
        if (item === undefined) return undefined
        return unmarshall(item) as MemberItem
    }

    /**
     * Delete member record.
     */
    async removeMembership(username: string, org: string) {
        const {Attributes: item} = await this.db.deleteItem(ddb.deleteItem(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
            return: "ALL_OLD"
        }))
        if (item === undefined) return undefined
        return unmarshall(item) as MembershipItem
    }

    /**
     * Fetch organisation information.
     */
    async fetchOrg(orgId: string) {
        const {Item: item} = await this.db.getItem(ddb.get(this.orgs, {
            key: {pk: `O#${orgId}`, sk: `info`},
        }))
        if (item === undefined) return undefined
        return unmarshall(item) as Org
    }

    /**
     * Fetch organisation members.
     */
    async orgMembers(orgId: string, startKey?: OrgKey): Promise<{
        lastKey?: OrgKey,
        members?: MembershipItem[]
    }> {
        const orgPk = `O#${orgId}`;
        const membersQuery = ddb.query(this.orgs, {
            keyCondition: ({key, val}) =>
                `${key.pk} = ${val(orgPk)} AND begins_with(${key.sk}, ${val('U#')})`,
            exclusiveStartKey: startKey
        })
        const {Items: memberIds, LastEvaluatedKey: lastKey} = await this.db.query(membersQuery)

        if (memberIds === undefined) return {}

        const membersBatch = ddb.batchGet().add(this.membership, {
            keys: memberIds.map(x => ({pk: x.sk.S, sk: x.pk.S})) as any,
        })

        const {Responses: batchResult} = await this.db.batchGetItem(membersBatch.input())
        if (batchResult === undefined) return {}
        const members = batchResult[this.membership.name]
        return {
            lastKey: lastKey !== undefined ? unmarshall(lastKey) as OrgKey : lastKey,
            members: members.map(x => unmarshall(x)) as MembershipItem[]
        }
    }

    async createOrg(request: OrgRequest): Promise<Org> {
        const orgId = uuid()
        const key = {pk: `O#${orgId}`, sk: `info`} as const;
        const item = {
            title: request.title,
            created_at: Date.now() / 1000,
        } as const;
        await this.db.putItem(ddb.put(this.orgs, {key, item}))
        return {
            ...key,
            ...item
        }
    }

    async removeOrg(orgId: string) {
        const {Attributes: item} = await this.db.deleteItem(ddb.deleteItem(this.orgs, {
            key: {pk: `O#${orgId}`, sk: `info`},
            return: "ALL_OLD"
        }))
        if (item === undefined) return undefined
        return unmarshall(item) as Org
    }
}
