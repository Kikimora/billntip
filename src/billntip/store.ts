import * as ddb from "@app/dynamodb";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {unmarshall} from "@aws-sdk/util-dynamodb";
import _ from "lodash";
import {Schema, TableAttributes, TableSchema} from "@app/dynamodb";
import {uuid} from "short-uuid";
import {internalError} from "@app/lambda";
import {ValuesGenerator} from "@app/dynamodb/schema";

const MemberKey = {
    pk: ddb.Type.String as `U#${string}`,
    sk: ddb.Type.String as `M`,
} as const

const MemberAttributes = {
    mangopayUid: ddb.Type.String,
    walletId: ddb.Type.String,
    kycDocumentId: ddb.Type.String,
} as const

type MemberTable = TableSchema<typeof MemberKey, typeof MemberAttributes>;
export type MemberItem = TableAttributes<MemberTable> & { pk: string }
export type RegisteredMemberItem = TableAttributes<MemberTable> & { pk: string, walletId: string, mangopayUid: string }

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
    prefix: OrgsTable;

    constructor(options: StoreOptions) {
        this.db = options.db ?? new DynamoDB()
        this.table = options.table
        this.membership = ddb.table(this.table, MemberhipKey, MembershipAttributes)
        this.members = ddb.table(this.table, MemberKey, MemberAttributes)
        this.prefix = ddb.table(this.table, OrgKey, OrgAttributes)
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
            ...item,
            pk: request.username,
            sk: request.org.id
        }
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
        return {
            ...unmarshall(invite),
            pk: username,
            sk: org
        }
    }

    /**
     * Reject an invite.
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
        return {
            ...unmarshall(invite),
            pk: username,
            sk: org
        }
    }

    /**
     * Update membership record.
     */
    async updateMembership(username: string, org: string, request: UpdateMembershipRequest) {

        const values = {
            title: request.org?.title,
            firstName: request.invited_by?.first_name,
            lastName: request.invited_by?.last_name,
            email: request.invited_by?.email,
            role: request.role,
        }

        const item = ddb.update(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
            values,
            expression: ({attr, ref}) => {
                const updates = []

                if (values.title !== undefined)
                    updates.push(`${attr.org.title} = ${ref('title')}`)

                if (values.firstName !== undefined)
                    updates.push(`${attr.invited_by.first_name} = ${ref('firstName')}`)

                if (values.lastName !== undefined)
                    updates.push(`${attr.invited_by.last_name} = ${ref('lastName')}`)

                if (values.email !== undefined)
                    updates.push(`${attr.invited_by.email} = ${ref('email')}`)

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
        return {
            ...unmarshall(invite),
            pk: username, sk: org
        }
    }

    /**
     * Fetch membership record.
     */
    async fetchMembership(username: string, org: string): Promise<MembershipItem | undefined> {
        const {Item: item} = await this.db.getItem(ddb.get(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
        }))
        if (item === undefined) return undefined
        return {
            ...unmarshall(item),
            pk: username, sk: org
        }
    }

    /**
     * Fetch member record.
     */
    async fetchMember(username: string): Promise<MemberItem | undefined> {
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
    createMember(username: string): MemberItem {
        return {
            pk: username
        }
    }

    async updateMember({pk, ...member}: MemberItem) {

        const item = ddb.update(this.members, {
            key: {pk: `U#${pk}`, sk: 'M'},
            values: {
                walletId: member.walletId ?? null,
                mangopayUid: member.mangopayUid ?? null,
                kycDocumentId: member.kycDocumentId ?? null,
            },
            expression: ({attr, ref}) => ({
                set: {
                    [attr.walletId]: ref('walletId'),
                    [attr.mangopayUid]: ref('mangopayUid'),
                    [attr.kycDocumentId]: ref('kycDocumentId')
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
    async removeMembership(username: string, org: string) {
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
        const {Item: item} = await this.db.getItem(ddb.get(this.prefix, {
            key: {pk: `O#${orgId}`, sk: `info`},
        }))
        if (item === undefined) return undefined
        return {
            ...unmarshall(item),
            pk: orgId
        }
    }

    /**
     * Fetch organisation members.
     */
    async orgMembers(orgId: string, startKey?: OrgKey): Promise<{
        lastKey?: OrgKey,
        members?: MembershipItem[]
    }> {
        const orgPk = `O#${orgId}`;
        const membersQuery = ddb.query(this.prefix, {
            values: {orgPk, prefix: 'U#'},
            keyCondition: ({key, ref}) =>
                `${key.pk} = ${ref('orgPk')} AND begins_with(${key.sk}, ${ref('prefix')})`,
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
            members: members.map(x => unmarshall(x)).map(x => ({
                ...x,
                pk: x.pk.substring(0, 2 /*U#.length*/),
                sk: x.sk.substring(0, 2 /*O#.length*/)
            })) as MembershipItem[]
        }
    }

    async createOrg(request: OrgRequest) {
        const orgId = uuid()
        const key = {pk: `O#${orgId}`, sk: `info`} as const;
        const item = {
            title: request.title,
            created_at: Date.now() / 1000,
        } as const;
        await this.db.putItem(ddb.put(this.prefix, {key, item}))
        return {
            pk: orgId,
            ...item
        }
    }

    async removeOrg(orgId: string) {
        const {Attributes: item} = await this.db.deleteItem(ddb.deleteItem(this.prefix, {
            key: {pk: `O#${orgId}`, sk: `info`},
            return: "ALL_OLD"
        }))
        if (item === undefined) return undefined
        return {
            ...unmarshall(item),
            pk: orgId
        }
    }
}
