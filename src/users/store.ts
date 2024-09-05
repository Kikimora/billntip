import {DDB} from "@app/lambda";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {UserAttribute} from "@src/users/attributes";
import * as Schemas from "@src/users/schemas";


// pk               sk          attributes
// user:<username>  A#<name>    name, value or alias, pending
// user:<username>  'U'         deleted
// alias:<alias>    'AL'        username

// GSI Attributes:
// pk         sk        attributes
// name       value     username

const AliasKey = DDB.Key({
    /**
     * Alias key, e.g. `alias#email@example.com`
     */
    pk: DDB.TemplateLiteral([DDB.Literal("AL#"), DDB.String]),
    /**
     * Constant 'AL'
     */
    sk: DDB.Literal('AL')
})
const AliasAttribute = DDB.Item({
    /**
     * Username corresponding to the alias.
     */
    username: DDB.String,
    /**
     * Alias attribute name
     */
    name: DDB.String,
    /**
     * Whenever alias verified or not.
     */
    verified: DDB.Boolean
})
const AliasSchema = {
    key: AliasKey,
    item: AliasAttribute
} as const
type AliasTable = DDB.Table<typeof AliasSchema>
type Alias = DDB.ItemType<AliasTable>

/**
 * Aliases view maps aliases to Cognito usernames.
 */
const AttributeKey = DDB.Key({
    /**
     * Username as provided by the user.
     */
    pk: DDB.TemplateLiteral([DDB.Literal('U#'), DDB.String]),
    /**
     * Attribute or user record discriminator.
     */
    sk: DDB.TemplateLiteral([DDB.Literal('A#'), DDB.String])
})
const Attribute = DDB.Item({
    /**
     * Attribute name (valid for sk = 'A#*').
     */
    name: DDB.String,
    /**
     * Attribute or verified alias value (valid for sk = 'A#*').
     */
    value: DDB.Optional(DDB.String),
    /**
     * Unverified alias value (valid for sk = 'A#*').
     */
    unverifiedValue: DDB.Optional(DDB.String),
    /**
     * Indicates whenever attribute is an alias (valid for sk = 'A#*').
     */
    isAlias: DDB.Optional(DDB.Boolean)
})
const AttributeSchema = {key: AttributeKey, item: Attribute}
type AttributesTable = DDB.Table<typeof AttributeSchema>
type Attribute = DDB.ItemType<AttributesTable>

function isAttribute(record: Record<string, any>): record is Attribute {
    return record.sk.startsWith('A#')
}

/**
 * Aliases view maps aliases to Cognito usernames.
 */
const UserKey = DDB.Key({
    /**
     * Username as provided by the user.
     */
    pk: DDB.TemplateLiteral([DDB.Literal('U#'), DDB.String]),
    /**
     * Attribute or user record discriminator.
     */
    sk: DDB.Literal('U')
})
const User = DDB.Item({
    /**
     * Map of all verified attributes.
     */
    attributes: DDB.Map(DDB.String),
    /**
     * Soft delete flag (valid for sk = 'U').
     */
    deleted: DDB.Boolean
})
const UsersSchema = {key: UserKey, item: User}
type UsersTable = DDB.Table<typeof UsersSchema>

export interface UserItem extends DDB.NonKeyType<UsersTable> {
    id: string
}

function isUser(record: Record<string, any>): record is UserItem {
    return record.sk === 'U'
}

const AttributeIndexKey = DDB.Key({
    name: DDB.String,
    value: DDB.String,
})
const AttributeIndexValue = DDB.Item({
    pk: DDB.TemplateLiteral([DDB.Literal('U#'), DDB.String])
})
const AttributeIndexSchema = {key: AttributeIndexKey, item: AttributeIndexValue}
type AttributesIndex = DDB.Table<typeof AttributeIndexSchema>
type AttributeIndexValue = DDB.ItemType<AttributesTable>

const Schema = {
    key: DDB.Key({pk: DDB.String, sk: DDB.String}),
    item: DDB.Union([User, Attribute, AliasAttribute])
}
type UsersData = DDB.Table<typeof Schema>

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
    readonly db: DDB.DynamoDB
    readonly data: UsersData

    constructor(options: UserStoreOptions) {
        this.db = DDB.dynamodb({db: options.db})
        this.aliasAttributes = new Set(options.aliasAttributes ?? DefaultAliasAttributes)
        this.aliasAttributes.add('username')
        this.maxAttributes = options.maxAttributes ?? Schemas.MaxAttributes

        this.data = this.db.table(options.table, Schema)
    }

    async lookupAlias(usernameOrAlias: string): Promise<Alias | undefined> {
        const Alias = this.data.narrow(AliasSchema)
        const {Item: userItem} = await Alias.get({key: aliasKey(usernameOrAlias)})
        if (userItem === undefined) {
            return undefined
        }
        return userItem
    }

    async fetch(username: string) {
        const {data} = this
        username = `U#` + username
        const {Items: items} = await data.query({
            keyCondition: ({key, ref}) => `${key.pk} = ${ref('username')}`
        }, {username})

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

        for (const item of items) {
            if (isAttribute(item)) {
                attributes.push(makeAttribute(item))
            } else if (isUser(item)) {
                deleted = item.deleted ?? false
            }
        }

        return {attributes, deleted}
    }

    async batchFetch(usernames: string[], options?: BatchFetchOptions): Promise<UserItem[]> {
        const {data} = this
        const User = data.narrow(UsersSchema)
        const deletedOk = options?.fetchDeleted ?? false
        const {Responses: users} = await User.batchGet({
            keys: usernames.map(userKey),
        })
        return users.filter(x => !x.deleted || deletedOk).map(function (u) {
            return {
                ...u,
                id:u.pk.substring(2/*U#.length*/)
            }
        })
    }

    isAliasAttribute(attribute: UserAttribute | string): boolean {
        if (typeof attribute === "string")
            return this.aliasAttributes.has(attribute)
        else
            return this.aliasAttributes.has(attribute.name)
    }

    makeTransactBuilder(username: string) {
        return new UserTxBuilder(username, this.data, this.db)
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
    private readonly tx: DDB.TransactWriteBuilder

    constructor(private readonly username: string,
                private readonly data: UsersData,
                db: DDB.DynamoDB) {
        this.tx = db.transactWrite()
    }

    updateAttribute(attr: UserAttributeItem) {
        const {username, tx, data} = this
        const Attribute = data.narrow(AttributeSchema)
        updateAttribute(Attribute.with(tx), username, attr)
    }

    deleteAttribute(attr: UserAttributeItem) {
        const {username, tx, data} = this
        const Attribute = data.narrow(AttributeSchema)
        deleteAttribute(Attribute.with(tx), username, attr.name)
    }

    /**
     * Create or update alias record, does nothing if attribute is not an alias.
     */
    refreshAliasRecord(attr: UserAttributeItem, alias: 'verified' | 'unverified' | 'both' = 'both') {
        const {username, tx, data} = this
        if (attr.isAlias) {
            const Aliases = data.narrow(AliasSchema)
            const tableTx = Aliases.with(tx)
            if (attr.value !== undefined && (alias === 'verified' || alias === 'both')) {
                refreshAliasRecord(tableTx, username, attr.name, attr.value, true)
            }
            if (attr.unverifiedValue !== undefined && (alias === 'unverified' || alias === 'both')) {
                refreshAliasRecord(tableTx, username, attr.name, attr.unverifiedValue, false)
            }
        }
    }

    /**
     * Delete alias record, does nothing if attribute is not an alias.
     */
    deleteAliasRecord(attr: UserAttributeItem, alias: 'verified' | 'unverified' | 'both' = 'both') {
        const {username, tx, data} = this
        if (attr.isAlias) {
            const Aliases = data.narrow(AliasSchema)
            const tableTx = Aliases.with(tx)
            if (attr.value !== undefined && (alias === 'verified' || alias === 'both')) {
                dropAliasRecord(tableTx, username, attr.value)
            }
            if (attr.unverifiedValue !== undefined && (alias === 'unverified' || alias === 'both')) {
                dropAliasRecord(tableTx, username, attr.unverifiedValue)
            }
        }
    }

    softDeleteAttribute(attr: UserAttributeItem) {
        const {username, tx, data} = this
        const Attribute = data.narrow(AttributeSchema)
        if (attr.isAlias) {
            updateAttribute(Attribute.with(tx), username, {
                ...attr,
                value: undefined,
                unverifiedValue: attr.value
            })
        }
    }

    createUser(attributes: Record<string, string>) {
        const {username, tx, data} = this
        const Users = data.narrow(UsersSchema)
        createUser(Users.with(tx), username, attributes)
    }

    deleteUser() {
        const {username, tx, data} = this
        const Users = data.narrow(UsersSchema)
        deleteUser(Users.with(tx), username)
    }

    updateUser({deleted, attributes}: { deleted?: boolean, attributes?: Record<string, string> }) {
        const {username, tx, data} = this
        const Users = data.narrow(UsersSchema)
        updateUser(Users.with(tx), username, deleted, attributes)
    }

    async run() {
        const {tx} = this
        if (!tx.isEmpty) {
            await tx.exec();
        }
    }
}


function aliasKey(username: string) {
    return {pk: `AL#${username}`, sk: 'AL'} as const
}

function refreshAliasRecord(tx: DDB.TransactWrite<AliasTable>, username: string, name: string, alias: string, verified: boolean) {
    return tx.add({
        action: "update",
        key: aliasKey(alias),
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
    }, {username, verified, name})
}

function dropAliasRecord(tx: DDB.TransactWrite<AliasTable>, username: string, alias: string) {
    return tx.add({
        action: "delete",
        key: aliasKey(alias),
        condition: ({key, attr, ref}) => `attribute_not_exists(${key.pk}) OR ${attr.username} = ${ref.val(username)}`,
        returnOnConditionFailure: "ALL_OLD"
    })
}

function attributeKey(username: string, attribute: string) {
    return {pk: `U#${username}`, sk: `A#${attribute}`} as const
}

function userKey(username: string) {
    return {pk: `U#${username}`, sk: `U`} as const
}

function createUser(tx: DDB.TransactWrite<UsersTable>, username: string, attributes: Record<string, string>) {
    return tx.add({
        action: "update",
        key: userKey(username),
        expression: ({attr, ref}) => ({
            set: {
                [attr.deleted]: ref('false'),
                [attr.attributes.toString()]: ref('attributes')
            },
        }),
        condition: ({key}) => `attribute_not_exists(${key.pk}) AND attribute_not_exists(${key.sk})`
    }, {false: false, attributes})
}

function updateUser(tx: DDB.TransactWrite<UsersTable>, username: string, deleted?: boolean, attributes?: Record<string, string>) {
    return tx.add({
        action: "update",
        key: userKey(username),
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
    }, {deleted, attributes})
}

function deleteUser(tx: DDB.TransactWrite<UsersTable>, username: string) {
    return tx.add({
        action: "delete",
        key: userKey(username)
    })
}

function deleteAttribute(tx: DDB.TransactWrite<AttributesTable>, username: string, attribute: string) {
    return tx.add({
        action: "delete",
        key: attributeKey(username, attribute)
    })
}

function updateAttribute(tx: DDB.TransactWrite<AttributesTable>, username: string, attribute: UserAttributeItem) {
    return tx.add({
        action: "put",
        item: {...attributeKey(username, attribute.name), ...attribute}
    })
}

//https://youtrack.jetbrains.com/issue/WEB-68793
export default UserStore