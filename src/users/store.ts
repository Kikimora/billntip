import process from "process";
import _ from "@app/util";
import * as ddb from "@app/dynamodb";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {UserAttribute} from "@src/users/attributes";
import {unmarshall} from "@aws-sdk/util-dynamodb";
import * as Schemas from "@src/users/schemas";
import {TransactWriteItem} from "@app/dynamodb";

export const UsersTableName = process.env.USERS_TABLE ?? _.throw("Missing required USERS_TABLE env variable")


// pk               sk          attributes
// user:<username>  A#<name>    name, value or alias, pending
// user:<username>  'U'         deleted
// alias:<alias>    'AL'        username

// GSI Attributes:
// pk         sk        attributes
// name       value     username

/**
 * Aliases view maps aliases to Cognito usernames.
 */
const Aliases = ddb.table(UsersTableName, {
    /**
     * Alias key, e.g. `alias#email@example.com`
     */
    pk: ddb.Type.String as `AL#${string}`,
    /**
     * Constant 'AL'
     */
    sk: ddb.Type.String as 'AL'
}, {
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
})

/**
 * Users attributes.
 */
const Attributes = ddb.table(UsersTableName, {
    /**
     * Username as provided by the user.
     */
    pk: ddb.Type.String as `U#${string}`,
    /**
     * Attribute or user record discriminator.
     */
    sk: ddb.Type.String as `A#${string}` | `U`
}, {
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
    /**
     * Soft delete flag (valid for sk = 'U').
     */
    deleted: ddb.Type.Boolean
})

/**
 * User attribute storage item.
 */
export interface UserAttributeItem {
    readonly name: string
    readonly value?: string
    readonly unverifiedValue?: string
    readonly isAlias: boolean
}

/**
 * User storage item.
 */
export interface UserItem {
    deleted: boolean
}

/**
 * Default alias attributes.
 */
const AliasAttributes = ['phone_number', 'email']

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
    aliasAttributes?: string[]
}

export default class UserStore {
    private readonly aliasAttributes: Set<string>;
    public readonly maxAttributes: number;

    constructor(private readonly db: DynamoDB, options?: UserStoreOptions) {
        this.aliasAttributes = new Set(options?.aliasAttributes ?? AliasAttributes)
        this.aliasAttributes.add('username')
        this.maxAttributes = options?.maxAttributes ?? Schemas.MaxAttributes
    }

    async lookupAlias(usernameOrAlias: string) {
        const aliasItem = ddb.get(Aliases, {
            key: aliasKey(usernameOrAlias)
        });
        const {Item: userItem} = await this.db.getItem(aliasItem)
        if (userItem === undefined) {
            return undefined
        }
        return unmarshall(userItem) as ddb.AttributesSchemaType<typeof Aliases>
    }

    async fetch(username: string) {
        const {db} = this
        username = `U#` + username
        const query = ddb.query(Attributes, {
            keyCondition: ({key, val}) => `${key.pk} = ${val(username)}`
        })

        const {Items: items} = await db.query(query)
        if (items === undefined) return undefined

        const attributes: UserAttributeItem[] = []
        let deleted = false

        const makeAttribute = (item: ddb.TableSchemaType<typeof Attributes>): UserAttributeItem => {
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
            const item = unmarshall(dbItem) as ddb.TableSchemaType<typeof Attributes>
            if (item.sk.startsWith('A#')) {
                attributes.push(makeAttribute(item))
            } else if (item.sk === 'U') {
                deleted = item.deleted ?? false
            }

        }

        return {attributes, deleted}
    }

    isAliasAttribute(attribute: UserAttribute | string): boolean {
        if (typeof attribute === "string")
            return this.aliasAttributes.has(attribute)
        else
            return this.aliasAttributes.has(attribute.name)
    }

    makeTransactBuilder(username: string) {
        return new UserTxBuilder(username, this.db)
    }
}

class UserTxBuilder {
    private readonly tx = ddb.transactWrite()

    constructor(private readonly username: string,
                private readonly db: DynamoDB) {
    }

    updateAttribute(attr: UserAttributeItem) {
        const {username, tx} = this
        tx.add(Attributes, updateAttribute(username, attr))
    }

    deleteAttribute(attr: UserAttributeItem) {
        const {username, tx} = this
        tx.add(Attributes, deleteAttribute(username, attr.name))
    }

    refreshAliasRecord(attr: UserAttributeItem, alias: 'verified' | 'unverified' | 'both' = 'both') {
        const {username, tx} = this
        if (attr.isAlias) {
            if (attr.value !== undefined && (alias === 'verified' || alias === 'both')) {
                tx.add(Aliases, refreshAliasRecord(username, attr.name, attr.value, true))
            }
            if (attr.unverifiedValue !== undefined && (alias === 'unverified' || alias === 'both')) {
                tx.add(Aliases, refreshAliasRecord(username, attr.name, attr.unverifiedValue, false))
            }
        }
    }

    deleteAliasRecord(attr: UserAttributeItem, alias: 'verified' | 'unverified' | 'both' = 'both') {
        const {username, tx} = this
        if (attr.isAlias) {
            if (attr.value !== undefined && (alias === 'verified' || alias === 'both')) {
                tx.add(Aliases, dropAliasRecord(username, attr.value))
            }
            if (attr.unverifiedValue !== undefined && (alias === 'unverified' || alias === 'both')) {
                tx.add(Aliases, dropAliasRecord(username, attr.unverifiedValue))
            }
        }
    }

    softDeleteAttribute(attr: UserAttributeItem) {
        const {tx, username} = this
        if (attr.isAlias) {
            tx.add(Attributes, updateAttribute(username, {
                ...attr,
                value: undefined,
                unverifiedValue: attr.value
            }))
        }
    }

    createUser() {
        const {tx, username} = this
        tx.add(Attributes, createUser(username))
    }

    deleteUser() {
        const {tx, username} = this
        tx.add(Attributes, deleteUser(username))
    }

    updateUser(item: UserItem) {
        const {tx, username} = this
        tx.add(Attributes, updateUser(username, item.deleted))
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

function refreshAliasRecord(username: string, name: string, alias: string, verified: boolean): TransactWriteItem<typeof Aliases> {
    return {
        action: "update",
        key: aliasKey(alias),
        expression: ({attr, val}) => ({
            set: {
                [attr.username]: val(username),
                [attr.verified]: val(verified),
                [attr.name]: val(name),
            }
        }),
        condition: ({
                        key,
                        attr,
                        val
                    }) => `attribute_not_exists(${key.pk}) OR (${attr.username} = ${val(username)} AND ${attr.name} = ${val(name)})`,
        returnOnConditionFailure: "ALL_OLD"
    }
}

function dropAliasRecord(username: string, alias: string): TransactWriteItem<typeof Aliases> {
    return {
        action: "delete",
        key: aliasKey(alias),
        condition: ({key, attr, val}) => `attribute_not_exists(${key.pk}) OR ${attr.username} = ${val(username)}`,
        returnOnConditionFailure: "ALL_OLD"
    }
}

function attributeKey(username: string, attribute: string) {
    return {pk: `U#${username}`, sk: `A#${attribute}`} as const
}

function userKey(username: string) {
    return {pk: `U#${username}`, sk: `U`} as const
}

function createUser(username: string): ddb.TransactWriteItem<typeof Attributes> {
    return {
        action: "update",
        key: userKey(username),
        expression: ({attr, val}) => ({
            set: {
                [attr.deleted]: val(false)
            },
        }),
        condition: ({key}) => `attribute_not_exists(${key.pk}) AND attribute_not_exists(${key.sk})`
    }
}

function updateUser(username: string, deleted: boolean): ddb.TransactWriteItem<typeof Attributes> {
    return {
        action: "update",
        key: userKey(username),
        expression: ({attr, val}) => ({
            set: `${attr.deleted} = ${val(deleted)}`,
        }),
        condition: ({key}) => `attribute_exists(${key.pk}) AND attribute_exists(${key.sk})`
    }
}

function deleteUser(username: string): ddb.TransactWriteItem<typeof Attributes> {
    return {
        action: "delete",
        key: userKey(username)
    }
}

function deleteAttribute(username: string, attribute: string): TransactWriteItem<typeof Attributes> {
    return {
        action: "delete",
        key: attributeKey(username, attribute)
    }
}

function updateAttribute(username: string, attribute: UserAttributeItem): TransactWriteItem<typeof Attributes> {
    return {
        action: "put",
        key: attributeKey(username, attribute.name),
        item: attribute
    }
}
