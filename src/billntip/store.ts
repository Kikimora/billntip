import * as ddb from "@app/dynamodb";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {unmarshall} from "@aws-sdk/util-dynamodb";
import _ from "lodash";
import {AttributesSchemaType, SchemaType, TableSchemaType} from "@app/dynamodb";
import {KeySchema, KeySchemaType} from "@app/dynamodb/schema";

const MembershipKey = {
    pk: ddb.Type.String as `U#${string}`,
    sk: ddb.Type.String as `O#${string}`,
} as const

type MemberKey = SchemaType<typeof MembershipKey>

const MembershipAttributes = {
    org: {
        id: ddb.Type.String,
        title: ddb.Type.String
    },
    role: ddb.Type.String,
    invited_by: {
        username: ddb.Type.String,
        display_name: ddb.Type.String,
    },
    invited_at: ddb.Type.Number,
    accepted_at: ddb.Type.Number,
    rejected_at: ddb.Type.Number,
} as const

type MemberAttributes = SchemaType<typeof MembershipAttributes>

const OrgKey = {
    pk: ddb.Type.String as `O#${string}`,
    sk: ddb.Type.String as `info` | `U${string}`,
} as const

const OrgAttributes = {
    //info attributes
    title: ddb.Type.String,
    created_at: ddb.Type.Number
} as const

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
        display_name: string,
    },
    role?: string
}

export default class Store {
    db: DynamoDB;
    table: string;
    membership: ddb.Table<typeof MembershipKey, typeof MembershipAttributes>;
    orgs: ddb.Table<typeof OrgKey, typeof OrgAttributes>;

    constructor(options: StoreOptions) {
        this.db = options.db ?? new DynamoDB()
        this.table = options.table
        this.membership = ddb.table(this.table, MembershipKey, MembershipAttributes)
        this.orgs = ddb.table(this.table, OrgKey, OrgAttributes)
    }

    async memberships(username: string, filters: { accepted?: boolean, rejected?: boolean } = {
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
        return _.map(invites, x => unmarshall(x)) as ddb.TableSchemaType<typeof this.membership>[]
    }

    async inviteMember(request: InviteRequest) {
        await this.db.putItem(ddb.put(this.membership, {
            key: {pk: `U#${request.username}`, sk: `O#${request.org.id}`},
            item: {
                invited_by: request.invited_by,
                invited_at: Date.now() / 1000,
                role: request.role ?? 'member',
                org: {
                    id: request.org.id,
                    title: request.org.title
                },
            },
            condition: ({attr}) => `attribute_not_exists(${attr.accepted_at})`
        }))
    }

    async acceptInvite(username: string, org: string) {
        const item = ddb.update(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
            expression: ({
                             attr,
                             val
                         }) => `SET ${attr.accepted_at} = ${val(Date.now() / 1000)} REMOVE ${attr.rejected_at}`,
            condition: ({attr, key}) =>
                `attribute_not_exists(${attr.accepted_at}) AND attribute_exists(${key.pk}) AND attribute_exists(${key.sk})`
        });
        const {Attributes: invite} = await this.db.updateItem(item)
        if (invite === undefined) return undefined
        return unmarshall(invite)
    }

    async rejectInvite(username: string, org: string) {
        const item = ddb.update(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
            expression: ({attr, val}) => `SET ${attr.rejected_at} = ${val(Date.now() / 1000)}`,
            condition: ({attr, key}) =>
                `attribute_exists(${key.pk}) AND attribute_exists(${key.sk})`,
            return: "ALL_NEW"
        });
        const {Attributes: invite} = await this.db.updateItem(item)
        if (invite === undefined) return undefined
        return unmarshall(invite)
    }

    async fetchMember(username: string, org: string) {
        const {Item: item} = await this.db.getItem(ddb.get(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
        }))
        if (item === undefined) return undefined
        return unmarshall(item) as TableSchemaType<typeof this.membership>
    }

    async roleIn(username: string, org: string) {
        const {Item: item} = await this.db.getItem(ddb.get(this.membership, {
            key: {pk: `U#${username}`, sk: `O#${org}`},
        }))
        if (item === undefined) return undefined
        const member = unmarshall(item) as TableSchemaType<typeof this.membership>
        return member.role
    }

    async orgInfo(orgId: string) {
        const {Item: item} = await this.db.getItem(ddb.get(this.orgs, {
            key: {pk: `O#${orgId}`, sk: `info`},
        }))
        if (item === undefined) return undefined
        return unmarshall(item) as TableSchemaType<typeof this.orgs>
    }

    async members(orgId: string, startKey: KeySchemaType<typeof OrgKey>): Promise<{
        lastKey?: KeySchemaType<typeof OrgKey>,
        members?: SchemaType<typeof MembershipAttributes>[]
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
            lastKey: lastKey as KeySchema<typeof OrgKey>,
            members: members.map(x => unmarshall(x)) as SchemaType<typeof MembershipAttributes>[]
        }
    }
}