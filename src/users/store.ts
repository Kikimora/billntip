import {ddb} from "@app/lambda";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {UserAttribute} from "@src/users/attributes";
import {unmarshall} from "@aws-sdk/util-dynamodb";
import * as Schemas from "@src/users/schemas";


// pk               sk          attributes
// user:<username>  A#<name>    name, value or alias, pending
// user:<username>  'U'         deleted
// alias:<alias>    'AL'        username

// GSI Attributes:
// pk         sk        attributes
// name       value     username

const AliasKey = {
    /**
     * Alias key, e.g. `alias#email@example.com`
     */
    pk: ddb.Type.String as `AL#${string}`,
    /**
     * Constant 'AL'
     */
    sk: ddb.Type.String as 'AL'
} as const;

const AliasAttributes = {
    /**
     * Username corresponding to the alias.
     */
    username: ddb.Type.String,
    /**
     * Alias attribute name
     */
    name: ddb.Type.String,
    /**
     * Whenever alias verified or not.
     */
    verified: ddb.Type.Boolean
} as const;
type AliasTable = ddb.TableSchema<{pk: `AL#${string}`, sk:`AL`}, typeof AliasAttributes>
type Alias = ddb.TableItem<AliasTable>

/**
 * Aliases view maps aliases to Cognito usernames.
 */
const AttributeKey = {
    /**
     * Username as provided by the user.
     */
    pk: ddb.Type.String as `U#${string}`,
    /**
     * Attribute or user record discriminator.
     */
    sk: ddb.Type.String as `A#${string}`
};
const Attributes = {
    /**
     * Attribute name (valid for sk = 'A#*').
     */
    name: ddb.Type.String,
    /**
     * Attribute or verified alias value (valid for sk = 'A#*').
     */
    value: ddb.Type.String,
    /**
     * Unverified alias value (valid for sk = 'A#*').
     */
    unverifiedValue: ddb.Type.String,
    /**
     * Indicates whenever attribute is an alias (valid for sk = 'A#*').
     */
    isAlias: ddb.Type.Boolean,
};

type AttributesTable = ddb.TableSchema<typeof AttributeKey, typeof Attributes>
type Attribute = ddb.TableItem<AttributesTable>

function isAttribute(record: Record<string, any>): record is Attribute {
    return record.sk.startsWith('A#')
}

/**
 * Aliases view maps aliases to Cognito usernames.
 */
const UserKey = {
    /**
     * Username as provided by the user.
     */
    pk: ddb.Type.String as `U#${string}`,
    /**
     * Attribute or user record discriminator.
     */
    sk: ddb.Type.String as `U`
};
const UserAttributes = {
    /**
     * Map of all verified attributes.
     */
    attributes: ddb.Type.Map(ddb.Type.String),
    /**
     * Soft delete flag (valid for sk = 'U').
     */
    deleted: ddb.Type.Boolean
};

type UsersTable = ddb.TableSchema<typeof UserKey, typeof UserAttributes>
export type UserItem = ddb.TableAttributes<UsersTable> & { pk: string }

function isUser(record: Record<string, any>): record is UserItem {
    return record.sk === 'U'
}

const AttributeIndexKey = {
    name: ddb.Type.String,
    value: ddb.Type.String,
}
const AttributeIndexValue = {
    pk: ddb.Type.String as `U#${string}`
}
type AttributesIndex = ddb.TableSchema<{name:string, value:string}, typeof AttributeIndexValue>
type AttributeIndexValue = ddb.TableItem<AttributesTable>

/**
 * User attribute storage item.
 */
export interface UserAttributeItem {
    name: string
    value?: string
    unverifiedValue?: string
    isAlias?: boolean
}

/**
 * Default alias attributes.
 */
const DefaultAliasAttributes = ['phone_number', 'email']

/**
 * [User repository]{@link UserRepo} options.
 */
export interface UserStoreOptions {
    /**
     * Maximum number of attributes per user, default - 50
     */
    maxAttributes?: number
    /**
     * Attribute names that uniquely identify user and can be user.
     */
    aliasAttributes?: string[],
    /**
     * DynamoDB client instance to use
     */
    db?: DynamoDB,
    /**
     * User table name
     */
    table: string
    /**
     * Locks table name
     */
    locks: string
}

class UserStore {
    private readonly aliasAttributes: Set<string>;
    readonly maxAttributes: number;
    readonly db: DynamoDB
    readonly aliases: AliasTable
    readonly attributes: AttributesTable
    readonly users: UsersTable
    readonly attributesIndex: AttributesIndex

    constructor(options: UserStoreOptions) {
        this.db = options.db ?? new DynamoDB()
        this.aliasAttributes = new Set(options.aliasAttributes ?? DefaultAliasAttributes)
        this.aliasAttributes.add('username')
        this.maxAttributes = options.maxAttributes ?? Schemas.MaxAttributes

        this.aliases = ddb.tableOld(options.table, AliasKey, AliasAttributes)
        this.attributes = ddb.tableOld(options.table, AttributeKey, Attributes)
        this.attributesIndex = ddb.tableOld(options.table, AttributeIndexKey, AttributeIndexValue)
        this.users = ddb.tableOld(options.table, UserKey, UserAttributes)
    }

    async lookupAlias(usernameOrAlias: string) {
        const aliasItem = ddb.get(this.aliases, {
            key: aliasKey(usernameOrAlias)
        });
        const {Item: userItem} = await this.db.getItem(aliasItem)
        if (userItem === undefined) {
            return undefined
        }
        return unmarshall(userItem) as Alias
    }

    async fetch(username: string) {
        const {db} = this
        username = `U#` + username
        const query = ddb.query(this.attributes, {
            values: {username},
            keyCondition: ({key, ref}) => `${key.pk} = ${ref('username')}`
        })

        const {Items: items} = await db.query(query)
        if (items === undefined) return undefined

        const attributes: UserAttributeItem[] = []
        let deleted = false

        const makeAttribute = (item: Attribute): UserAttributeItem => {
            const name = item.name ?? "noname"
            const isAlias = item.isAlias ?? false
            const shouldBeAlias = this.isAliasAttribute(name)

            return {
                name,
                value: shouldBeAlias && !isAlias ? undefined : item.value,
                isAlias,
                unverifiedValue: shouldBeAlias && !isAlias ? item.value : item.unverifiedValue,
            }
        }

        for (const dbItem of items) {
            const item = unmarshall(dbItem)
            if (isAttribute(item)) {
                attributes.push(makeAttribute(item))
            } else if (isUser(item)) {
                deleted = item.deleted ?? false
            }
        }

        return {attributes, deleted}
    }

    async batchFetch(usernames: string[], options?: BatchFetchOptions): Promise<UserItem[]> {
        const deletedOk = options?.fetchDeleted ?? false
        const batch = ddb.batchGet().add(this.users, {
            keys: usernames.map(userKey),
        })
        const {Responses: response} = await this.db.batchGetItem(batch.input())
        if (response === undefined) return []

        const users = response[this.users.name]
        return users.map(x => unmarshall(x)).map(x => ({
            ...x,
            pk: x.pk.substring(2/*U#.length*/)
        }) as UserItem).filter(x => !x.deleted || deletedOk)
    }

    isAliasAttribute(attribute: UserAttribute | string): boolean {
        if (typeof attribute === "string")
            return this.aliasAttributes.has(attribute)
        else
            return this.aliasAttributes.has(attribute.name)
    }

    makeTransactBuilder(username: string) {
        return new UserTxBuilder(username, this.aliases, this.attributes, this.users, this.db)
    }
}

/**
 * Batch Fetch operation options.
 */
export interface BatchFetchOptions {
    /**
     * Allow fetch of deleted users, default - false
     */
    fetchDeleted?: boolean
}

class UserTxBuilder {
    private readonly tx = ddb.transactWrite()

    constructor(private readonly username: string,
                private readonly aliases: AliasTable,
                private readonly attributes: AttributesTable,
                private readonly users: UsersTable,
                private readonly db: DynamoDB) {
    }

    updateAttribute(attr: UserAttributeItem) {
        const {username, tx} = this
        tx.add(this.attributes, updateAttribute(username, attr))
    }

    deleteAttribute(attr: UserAttributeItem) {
        const {username, tx} = this
        tx.add(this.attributes, deleteAttribute(username, attr.name))
    }

    /**
     * Create or update alias record, does nothing if attribute is not an alias.
     */
    refreshAliasRecord(attr: UserAttributeItem, alias: 'verified' | 'unverified' | 'both' = 'both') {
        const {username, tx} = this
        if (attr.isAlias) {
            if (attr.value !== undefined && (alias === 'verified' || alias === 'both')) {
                tx.add(this.aliases, refreshAliasRecord(username, attr.name, attr.value, true))
            }
            if (attr.unverifiedValue !== undefined && (alias === 'unverified' || alias === 'both')) {
                tx.add(this.aliases, refreshAliasRecord(username, attr.name, attr.unverifiedValue, false))
            }
        }
    }

    /**
     * Delete alias record, does nothing if attribute is not an alias.
     */
    deleteAliasRecord(attr: UserAttributeItem, alias: 'verified' | 'unverified' | 'both' = 'both') {
        const {username, tx} = this
        if (attr.isAlias) {
            if (attr.value !== undefined && (alias === 'verified' || alias === 'both')) {
                tx.add(this.aliases, dropAliasRecord(username, attr.value))
            }
            if (attr.unverifiedValue !== undefined && (alias === 'unverified' || alias === 'both')) {
                tx.add(this.aliases, dropAliasRecord(username, attr.unverifiedValue))
            }
        }
    }

    softDeleteAttribute(attr: UserAttributeItem) {
        const {tx, username} = this
        if (attr.isAlias) {
            tx.add(this.attributes, updateAttribute(username, {
                ...attr,
                value: undefined,
                unverifiedValue: attr.value
            }))
        }
    }

    createUser(attributes: Record<string, string>) {
        const {tx, username} = this
        tx.add(this.users, createUser(username, attributes))
    }

    deleteUser() {
        const {tx, username} = this
        tx.add(this.users, deleteUser(username))
    }

    updateUser({deleted, attributes}: { deleted?: boolean, attributes?: Record<string, string> }) {
        const {tx, username} = this
        tx.add(this.users, updateUser(username, deleted, attributes))
    }

    async run() {
        const {tx, db} = this
        const input = tx.input();
        if ((input.TransactItems?.length ?? 0) > 0)
            await db.transactWriteItems(input)
    }
}


function aliasKey(username: string) {
    return {pk: `AL#${username}`, sk: 'AL'} as const
}

function refreshAliasRecord(username: string, name: string, alias: string, verified: boolean): ddb.TransactWriteItem<AliasTable> {
    return {
        action: "update",
        key: aliasKey(alias),
        values: {username, verified, name},
        expression: ({attr, ref}) => ({
            set: {
                [attr.username]: ref('username'),
                [attr.verified]: ref('verified'),
                [attr.name]: ref('name'),
            }
        }),
        condition: ({key, attr, ref}) =>
            `attribute_not_exists(${key.pk}) OR (${attr.username} = ${ref('username')} AND ${attr.name} = ${ref('name')})`,
        returnOnConditionFailure: "ALL_OLD"
    }
}

function dropAliasRecord(username: string, alias: string): ddb.TransactWriteItem<AliasTable> {
    return {
        action: "delete",
        key: aliasKey(alias),
        condition: ({key, attr, ref}) => `attribute_not_exists(${key.pk}) OR ${attr.username} = ${ref.val(username)}`,
        returnOnConditionFailure: "ALL_OLD"
    }
}

function attributeKey(username: string, attribute: string) {
    return {pk: `U#${username}`, sk: `A#${attribute}`} as const
}

function userKey(username: string) {
    return {pk: `U#${username}`, sk: `U`} as const
}

function createUser(username: string, attributes: Record<string, string>): ddb.TransactWriteItem<UsersTable> {
    return {
        action: "update",
        key: userKey(username),
        values: {false: false, attributes},
        expression: ({attr, ref}) => ({
            set: {
                [attr.deleted]: ref('false'),
                [attr.attributes.toString()]: ref('attributes')
            },
        }),
        condition: ({key}) => `attribute_not_exists(${key.pk}) AND attribute_not_exists(${key.sk})`
    }
}

function updateUser(username: string, deleted?: boolean, attributes?: Record<string, string>): ddb.TransactWriteItem<UsersTable> {
    return {
        action: "update",
        key: userKey(username),
        values: {deleted, attributes},
        expression({attr, ref}) {
            const update: Record<string, string> = {}
            if (deleted !== undefined) {
                update[attr.deleted] = ref('deleted')
            }
            if (attributes !== undefined) {
                update[attr.attributes.toString()] = ref('attributes')
            }
            return ({
                set: update,
            })
        },
        condition: ({key}) => `attribute_exists(${key.pk}) AND attribute_exists(${key.sk})`
    }
}

function deleteUser(username: string): ddb.TransactWriteItem<UsersTable> {
    return {
        action: "delete",
        key: userKey(username)
    }
}

function deleteAttribute(username: string, attribute: string): ddb.TransactWriteItem<AttributesTable> {
    return {
        action: "delete",
        key: attributeKey(username, attribute)
    }
}

function updateAttribute(username: string, attribute: UserAttributeItem): ddb.TransactWriteItem<AttributesTable> {
    return {
        action: "put",
        key: attributeKey(username, attribute.name),
        item: attribute
    }
}
//https://youtrack.jetbrains.com/issue/WEB-68793
export default UserStore