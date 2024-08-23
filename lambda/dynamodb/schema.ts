import _ from "lodash";
import {Simplify} from "type-fest";

/**
 * Describes structure of a DynamoDB record. That is, any entries except [`x:{$array:...}`]{@link DynamoDbArraySchema} or [`x:{$map:...}`]{@link DynamoDbMapSchema}.
 *
 * @example
 * const MySchema = {
 *     uid: D.String,
 *     profile: {
 *         firstName: D.String,
 *         lastName: D.String,
 *     }
 *     recentTransactions: D.Array({ txid: D.String, amount:D.Number }),
 *     pictures: D.Map(D.String)
 * } as const
 * //Note `as const` above this is critical for the type inference to work properly.
 */
export type DynamoDbSchema = { [key: string]: DynamoDbType } & { $array?: never } & { $map?: never };
/**
 * Describes basic DynamoDb type.
 */
export type DynamoDbBasicType = "S" | "N" | "B" | "SS" | "NS" | "BS" | "NULL" | "BOOL"
export type DynamoDbKeyType = "S" | "N" | "B"
export type DynamoDbKeySchema = { [key: string]: DynamoDbKeyType };
/**
 * Describes DynamoDb array schema.
 */
export type DynamoDbArraySchema = { $array: DynamoDbType };
/**
 * Describes DynamoDb map schema.
 */
export type DynamoDbMapSchema = { $map: DynamoDbType };
/**
 * Union of all DynamoDb type schemas.
 */
export type DynamoDbType = DynamoDbSchema
    | DynamoDbArraySchema
    | DynamoDbMapSchema
    | DynamoDbBasicType
    | string

//<!-- @formatter:off -->
/**
 * Convert {@link DynamoDbSchema} into a normal TypeScript type.
 * @example (MySchema described in the example section [here]{@link DynamoDbSchema})
 * const user: SchemaType<typeof MySchema> = {
 *     uid: "Some string",
 *     profile: {
 *         firstName: "Some string",
 *         lastName: "Some string"
 *     },
 *     recentTransactions: [{txid: "Some string", amount:10}],
 *     pictures: {
 *         "50x50": "https://...",
 *         "100x100": "https://...",
 *     }
 * }
 */
export type SchemaToType<T> = (
      T extends "S" ? string
    : T extends "N" ? number
    : T extends "B" ? Uint8Array
    : T extends "SS" ? Set<string>
    : T extends "NS" ? Set<number>
    : T extends "BS" ? Set<Uint8Array>
    : T extends "NULL" ? undefined
    : T extends "BOOL" ? boolean
    : T extends { $array: any } ? Array<SchemaToType<T['$array']>>
    : T extends { $map: any } ? {[key:string]: SchemaToType<T['$map']>}
    : T extends DynamoDbSchema ? { -readonly [k in keyof T] -?: SchemaToType<T[k]>; }
    : T extends string ? T
    : never
)

export namespace schema {
    export interface TableSchema {
        /**
         * DynamoDB table name
         */
        readonly name: string
        /**
         * Key attributes (partition and sort key).
         */
        readonly key: DynamoDbKeySchema
        /**
         * All other than key attributes of the table.
         */
        readonly attributes: DynamoDbSchema
        /**
         * DynamoDB index name
         */
        readonly index?: string
    }
    export type KeySchema<T extends TableSchema> = T['key']
    export type AttributesSchema<T extends TableSchema> = T['attributes']

    export type KeyType<T extends TableSchema> = KeySchemaToType<T['key']>
    export type AttributesType<T extends TableSchema> = Partial<SchemaToType<T['attributes']>>
    export type ItemType<T extends TableSchema> = AttributesType<T> & KeyType<T>

    type KeySchemaToType<T> = Simplify<{
        [key in keyof T & string]: T[key] extends "S" ? string : T[key] extends "N" ? number : T[key] extends "B" ? Uint8Array : never
    }>
//<!-- @formatter:off -->
    type SchemaToType<T> = (
          T extends "S" ? string
        : T extends "N" ? number
        : T extends "B" ? Uint8Array
        : T extends "SS" ? Set<string>
        : T extends "NS" ? Set<number>
        : T extends "BS" ? Set<Uint8Array>
        : T extends "NULL" ? undefined
        : T extends "BOOL" ? boolean
        : T extends { $array: any } ? Array<SchemaToType<T['$array']>>
        : T extends { $map: any } ? {[key:string]: SchemaToType<T['$map']>}
        : T extends DynamoDbSchema ? { -readonly [k in keyof T] -?: SchemaToType<T[k]>; }
        : T extends string ? T
        : never
    )
//<!-- @formatter:on -->
}


/**
 * Anything with `toString()` method.
 */
interface StringBuilder {
    toString(): string,
    valueOf():any
}

type KeyOf<T> = Exclude<keyof T, symbol>

/**
 * Mirrors shape of a {@link DynamoDbSchema} with props and functions generating DynamoDb attributes.
 * @example (MySchema described in the example section [here]{@link DynamoDbSchema})
 * const user = attributeGenerator(MySchema)
 * console.log(user.uid) //logs #uid
 * console.log(user.profile.firstName) //logs #profile.#firstName
 * console.log(user.recentTransactions(1).amount) //logs #recentTransactions[1].#amount
 * console.log(user.pictures('50x50')) //logs #pictures.#50x50
 */
export type AttributeGenerator<T> = (
      T extends DynamoDbBasicType ? string
    : T extends DynamoDbArraySchema ? (idx:number)=>AttributeGenerator<T['$array']> & StringBuilder
    : T extends DynamoDbMapSchema ? (idx:string)=>AttributeGenerator<T['$map']> & StringBuilder
    : T extends DynamoDbSchema ? { [k in KeyOf<T>]: AttributeGenerator<T[k]> & StringBuilder; }
    : T extends string ? T
    : never
    )
    & ((val: string) => string)


//<!-- @formatter:on -->

/**
 * {@link DynamoDbSchema} building blocks.
 */
export namespace Type {
    /**
     * DynamoDb string.
     */
    export const String = "S" as const
    /**
     * DynamoDb number.
     */
    export const Number = "N" as const
    /**
     * DynamoDb binary object.
     */
    export const Binary = "B" as const
    /**
     * DynamoDb string set.
     */
    export const StringSet = "SS" as const
    /**
     * DynamoDb number set.
     */
    export const NumberSet = "NS" as const
    /**
     * DynamoDb binary objects set.
     */
    export const BinarySet = "BS" as const
    /**
     * DynamoDb null (unknown item).
     */
    export const Unknown = "NULL" as const
    /**
     * DynamoDb boolean.
     */
    export const Boolean = "BOOL" as const
    /**
     * DynamoDb map, mapping from string to a DynamoDb attributes.
     */
    export const Map = <T extends DynamoDbType>(val: T) => ({$map: val})
    /**
     * DynamoDb array, ordered collection of DynamoDb attributes.
     */
    export const Array = <T extends DynamoDbType>(val: T) => ({$array: val})
}


/**
 * Create {@link AttributeGenerator} for a given schema.
 * @param schema - attributes schema
 * @param callback - callback function to call each time an attribute generated.
 */
export function attributeGenerator<T>(schema: T, callback?: (path: string[]) => void): AttributeGenerator<T> {
    const attr = function (attributeName: string) {
        return new Builder(attributeName, undefined, callback)
    }
    attr.toString = function (this: BuilderHolder) {
        return this[__builder]?.toString() ?? ""
    }

    if (schema === null || typeof schema !== "object")
        return attr as any

    for (const [key, type] of Object.entries(schema)) {
        if (isBasicDynamoType(type)) {
            Object.defineProperty(attr, key, {
                get: function (this: BuilderHolder) {
                    const builder = new Builder(key, this[__builder], callback);
                    return builder.toString()
                }
            })
        }

        if (isDynamoMap(type) || isDynamoArray(type)) {
            const collectionFn = collection(type)
            Object.defineProperty(attr, key, {
                get: function (this: BuilderHolder) {
                    const builder = new Builder(key, this[__builder], callback)
                    return collectionFn.item(builder)
                }
            })
        }

        if (isDynamoSchema(type)) {
            const proto = attributeGenerator(type)
            Object.defineProperty(attr, key, {
                get: function (this: BuilderHolder) {
                    const child = Object.create(proto)
                    child[__builder] = new Builder(key, this[__builder], callback)
                    return child
                }
            })
        }
    }
    return attr as any
}

/**
 * Helper function to generate property values for the DynamoDB expressions. See {@link valueGenerator} for details.
 */
export interface ValuesGenerator<T> {
    /**
     * Reference named value from values, items or similar part of the DynamoDB expression.
     * @param key value key
     */
    (key: keyof T & string): string

    /**
     * Create DynamoDB expression variable named `__valN` with a given value. N starts with 1.
     * @param value value to assign to a new variable.
     */
    val(value: any): string
}

/**
 * Update expression context provides normal context variables (e.g. key, attr, val) as well as helper methods to
 * generate common update expression such as SET #x1=:x1, #x2=:x2 and REMOVE #x1, #x2
 */
export class UpdateContext<T extends TableSchema, V> {

    public readonly ctx: UpdateContext<T, V>

    constructor(readonly ref: ValuesGenerator<V>,
                readonly key: AttributeGenerator<T['key']>,
                readonly attr: AttributeGenerator<T['attributes']>) {
        this.ctx = this
    }

    set(collection: Partial<TableItem<T>>): string
    set(collection: unknown[], expressionGenerator: (value: any, index: number) => string): string
    set(collection: object, expressionGenerator: (value: any, key: string) => string): string
    set(collection: any, x?: (value: any, key?: any) => string): string {
        let expressions: string[]
        if (x === undefined) {
            expressions = _.map(collection, (value, name) => {
                if (name in this.attr) {
                    return `${this.attr[name]} = ${this.ref(value)}`
                }
                return `${this.key[name]} = ${this.ref(value)}`
            })
        } else {
            expressions = _.map(collection, x)
        }
        return 'SET ' + expressions.join(', ')
    }
}

/**
 * Create a value generator for a given values. Value
 * @example
 * const v = valueGenerator<{id:number, name:string}>({id:1, name:"Andrey"})
 * console.log(v("Hello")) //prints :__v1, calls callback(":__v1", "Hello")
 * console.log(v("World")) //prints :__v2, calls callback(":__v2", "World")
 * console.log(v.id) //prints :id, calls callback(":id", 1)
 * console.log(v.name) //prints :name, calls callback(":name", "Andrey")
 * @param values - value object
 * @param callback - callback function called every time a value expression is generated.
 */
export function valueGenerator<T>(values: T, callback: (key: string, value: any) => void): ValuesGenerator<T> {
    const generator = function (key: keyof T & string) {
        const valueKey = ':' + key
        callback(valueKey, values[key])
        return valueKey
    }
    let valIndex = 1
    generator.val = function (value: any) {
        const valueKey = ':__val' + valIndex++
        callback(valueKey, value)
        return valueKey
    }
    return generator
}

type CollectionAttributes<T> = { item(builder: Builder): AttributeGenerator<T> }

function collectionItemType<T extends DynamoDbArraySchema | DynamoDbMapSchema>(collectionType: T): DynamoDbType {
    if (isDynamoArray(collectionType)) return collectionType.$array
    return collectionType.$map
}

function collection<T extends DynamoDbMapSchema | DynamoDbArraySchema>(col: T): CollectionAttributes<T> {
    let itemType = collectionItemType(col)
    let value: any
    if (isBasicDynamoType(itemType)) {
        value = function (this: Builder, idx: string | number) {
            return new Builder(idx, this)
        }
    }

    if (isDynamoMap(itemType) || isDynamoArray(itemType)) {
        const attrs = collection(itemType)
        value = function (this: Builder, idx: string | number) {
            return attrs.item(new Builder(idx, this))
        }
    }

    if (isDynamoSchema(itemType)) {
        const proto = attributeGenerator(itemType)
        value = function (this: Builder, idx: string | number) {
            const child = Object.create(proto)
            child[__builder] = new Builder(idx, this)
            return child
        }
    }

    value.item = function (builder: Builder) {
        const x = value.bind(builder)
        x.toString = function () {
            return builder.toString()
        }
        return x
    }

    return value
}

export function isBasicDynamoType(x: DynamoDbType): x is DynamoDbBasicType {
    return typeof x === "string"
}

export function isDynamoArray(x: DynamoDbType): x is DynamoDbArraySchema {
    return typeof x === "object" && '$array' in x
}

export function isDynamoMap(x: DynamoDbType): x is DynamoDbMapSchema {
    return typeof x === "object" && '$map' in x
}

export function isDynamoSchema(x: DynamoDbType): x is DynamoDbSchema {
    return typeof x === "object" && !('$array' in x) && !('$map' in x)
}

const __builder = Symbol("__builder")

class Builder implements StringBuilder {
    constructor(readonly key: string | number,
                readonly parent?: Builder,
                readonly callback?: (path: string[]) => void) {
    }

    valueOf() {
        return this.toString()
    }

    toString() {
        const path = []
        let builder: Builder
        for (builder = this; builder.parent !== undefined; builder = builder.parent) {
            const {key} = builder
            if (typeof key === "number") {
                path.push("[" + key + "]")
            } else {
                path.push('#' + key)
                path.push(".")
            }
        }
        path.push('#' + builder.key)
        builder.callback?.(path)
        return path.reverse().join("")
    }
}

interface BuilderHolder {
    readonly [__builder]?: Builder
}

/**
 * Defines DynamoDB table or part of the table structure. Constructed using the {@link tableOld} function.
 *
 * @example
 * //note use of `as const`, this is critical for the type inference to work.
 * const Table = table("MyTable",
 *      {pk: D.String, sk:D.Number} as const,
 *      {name:D.String, age:D.Number} as const)
 */
export interface TableSchema<Key = any, Attributes = any> {
    /**
     * DynamoDB table name
     */
    readonly name: string
    /**
     * Key attributes (partition and sort key).
     */
    readonly key: DynamoDbSchemaType<Key>
    /**
     * All other than key attributes of the table.
     */
    readonly attributes: DynamoDbSchemaType<Attributes>
    /**
     * DynamoDB index name
     */
    readonly index?: string
}

/**
 * Requires T to be {@link DynamoDbSchema}, otherwise yield `never`. This is a helper type to simplify signatures
 * @example
 * interface Table<Key, Attributes> {
 *     readonly key: DynamoDbSchemaType<Key>
 *     readonly attributes: DynamoDbSchemaType<Attributes>
 * }
 * function x<T extends TableType<T>>(table: T) {}
 * //instead of
 * interface Table<Key extends DynamoDbSchema, Attributes extends DynamoDbSchema> {
 *     readonly key: Key
 *     readonly attributes: Attributes
 * }
 * function x<T extends DynamoDbSchema, K extends DynamoDbSchema>(table: Table<T, K>) {}
 */
export type DynamoDbSchemaType<T> = T extends DynamoDbSchema ? T : never
/**
 * Require T to be {@link TableSchema}, otherwise yield `never`.
 *
 * In combination with {@link DynamoDbSchemaType} this type helps to simplify function signatures
 * @example
 * @example
 * interface Table<Key, Attributes> {
 *     readonly key: DynamoDbSchemaType<Key>
 *     readonly attributes: DynamoDbSchemaType<Attributes>
 * }
 * function x<T extends TableType<T>>(table: T) {}
 * //instead of
 * interface Table<Key extends DynamoDbSchema, Attributes extends DynamoDbSchema> {
 *     readonly key: Key
 *     readonly attributes: Attributes
 * }
 * function x<T extends DynamoDbSchema, K extends DynamoDbSchema>(table: Table<T, K>) {} */
export type TableType<T> = TableSchema<KeySchema<T>, AttributesSchema<T>>
/**
 * A key schema of the {@link TableSchema}
 */
type KeySchema<T> = T extends TableSchema ? T['key'] : never
/**
 * Attributes schema of the {@link TableSchema}
 */
type AttributesSchema<T> = T extends TableSchema ? T['attributes'] : never
/**
 * Combined key and attributes schema of the {@link TableSchema}
 */
export type TableItem<T extends TableSchema> = SchemaToType<T['key']> & Partial<SchemaToType<T['attributes']>>
/**
 * Type of the table attributes.
 */
export type TableAttributes<T extends TableSchema> = Partial<SchemaToType<T['attributes']>>
/**
 * Type of the table key attributes.
 */
export type TableKey<T extends TableSchema> = SchemaToType<T['key']>

/**
 * Make DynamoDB table definition.
 * @param name - DynamoDB table name
 * @param key - key attributes (partition and sort key)
 * @param attributes - other than key attributes of the table
 *
 * @example - single table design for users and teams
 * import {D, table} from "@app/dynamodb"
 * const Users = table("SingleTable", {
 *     pk: D.String as `usr_${string}`
 * }, {
 *     name: D.String,
 *     age: D.Number
 * })
 * const Teams = table("SingleTable", {
 *     pk: D.String as `team_${string}`,
 *     sk: D.String as `usr_${string}`,
 * }, {
 *     joined_at: D.Number,
 *     score: D.Number
 * })
 */
export function tableOld<Key, Attributes>(name: string,
                                                                 key: DynamoDbSchemaType<Key>,
                                                                 attributes: DynamoDbSchemaType<Attributes>): TableSchema<Key, Attributes> {
    return {
        name,
        key,
        attributes
    } as const
}

/**
 * Function generating a DynamoDB expression such as {@link ddb.UpdateItemCommandInput.UpdateExpression} or {@link ddb.PutItemCommand.ConditionExpression}.
 * @param key - key attributes generator
 * @param attributes - non-key attributes generator
 * @param val - context values passed to the command
 * @return string - generated expression
 */
export type ExpressionGenerator<T extends TableSchema, V> = (context: {
    key: AttributeGenerator<T['key']>,
    attr: AttributeGenerator<T['attributes']>,
    ref: ValuesGenerator<V>
}) => string | undefined

/**
 * Function generating a DynamoDB projection expression.
 * @param key - key attributes generator
 * @param attributes - non-key attributes generator
 * @return string - generated expression
 */
export type ProjectionGenerator<T extends TableSchema> = (context: {
    key: AttributeGenerator<T['key']>,
    attr: AttributeGenerator<T['attributes']>
}) => string[]

/**
 * DynamoDB update expression
 */
type UpdateExpression = {
    set?: string | Record<string, string> | (string | Record<string, string>)[],
    add?: string | string[],
    remove?: string | string[],
    delete?: string | string[],
}

export function updateExpression(exp?: string | string[] | UpdateExpression): string | undefined {
    if (exp === undefined) return undefined
    if (typeof exp === "string") return exp
    if (Array.isArray(exp))
        return _.compact(exp).join(", ")


    //deal with UpdateExpression
    const expression = []
    for (let [op, value] of Object.entries(exp)) {
        if (value === undefined) continue
        //op is SET, ADD, REMOVE or DELETE
        const statement = []
        if (typeof value === "string") {
            statement.push(value)
        } else if (Array.isArray(value)) {
            //(string | Record<string, string>)[]
            statement.push(..._.compact(value).map(value => {
                if (typeof value === "string") {
                    return value
                } else {
                    return processObject(value)
                }
            }))
        } else {
            //Record<string, string>
            statement.push(...processObject(value))
        }
        if (statement.length > 0)
            expression.push(op.toUpperCase() + " " + statement.join(", "))
    }
    return expression.join(' ')

    function processObject(exp: Record<string, string>) {
        return _(exp).map((value, attr) => `${attr} = ${value}`).value()
    }
}

/**
 * Function generating a DynamoDB update expression (see {@link ddb.UpdateItemCommandInput.UpdateExpression}).
 * @param builder - update expression builder
 * @return string - generated expression
 */
export type UpdateGenerator<T extends TableSchema, V> = (context: UpdateContext<T, V>) => string | string[] | UpdateExpression


/**
 * Function generating a DynamoDB query key condition expression.
 * @param key - key attributes generator
 * @param val - context values passed to the command
 * @return string - generated expression
 */
export type KeyConditionGenerator<T extends TableSchema, V> = (context: {
    key: AttributeGenerator<T['key']>,
    ref: ValuesGenerator<V>
}) => string
/**
 * Function generating a DynamoDB query filter condition expression.
 * @param attributes - non-key attributes generator
 * @param val - context values passed to the command
 * @return string - generated expression
 */
export type FilterConditionGenerator<T extends TableSchema, V> = (context: {
    attr: AttributeGenerator<T['attributes']>,
    ref: ValuesGenerator<V>
}) => string
