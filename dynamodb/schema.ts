import _ from "lodash";

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
export type SchemaType<T> = (
      T extends "S" ? string
    : T extends "N" ? number
    : T extends "B" ? Uint8Array
    : T extends "SS" ? Set<string>
    : T extends "NS" ? Set<number>
    : T extends "BS" ? Set<Uint8Array>
    : T extends "NULL" ? undefined
    : T extends "BOOL" ? boolean
    : T extends { $array: any } ? Array<SchemaType<T['$array']>>
    : T extends { $map: any } ? {[key:string]: SchemaType<T['$map']>}
    : T extends DynamoDbSchema ? { -readonly [k in keyof T] -?: SchemaType<T[k]>; }
    : T extends string ? T
    : never
)

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
 * A shallow mirrors (no nested properties) of the shape of a {@link DynamoDbSchema} with props generating DynamoDb value expressions.
 * @example (MySchema described in the example section [here]{@link DynamoDbSchema})
 * const user = valueGenerator({uid:"Some string", "firstName":"Andrey", "lastName":"Verbin"})
 * console.log(user.uid) //logs :uid
 * console.log(user.firstName) //logs :firstName
 * console.log(user.lastName) //logs :lastName
 */
export type ValuesGenerator<T> = {
    [key in KeyOf<T>]-?: string
} & ((val: any, key?: string) => string)

/**
 * Update expression context provides normal context variables (e.g. key, attr, val) as well as helper methods to
 * generate common update expression such as SET #x1=:x1, #x2=:x2 and REMOVE #x1, #x2
 */
export class UpdateContext<T, V = unknown> {

    public readonly ctx: UpdateContext<T, V>

    constructor(readonly val: ValuesGenerator<V>,
                readonly key: AttributeGenerator<KeySchema<T>>,
                readonly attr: AttributeGenerator<AttributesSchema<T>>) {
        this.ctx = this
    }

    updateMap(mode: 'create' | 'update',
              key: keyof AttributeGenerator<AttributesSchema<T>>,
              values: Record<string, unknown>) {
        return mode == 'update'
            ? _(values)
                .mapKeys((_1, name) => this.attr[key](name))
                .mapValues((value) => this.val(value))
                .value()
            : `${this.attr[key]} = ${this.val(values)}`;
    }

    set(collection: Partial<SchemaType<TableSchema<T>>>): string
    set(collection: unknown[], expressionGenerator: (value: any, index: number) => string): string
    set(collection: object, expressionGenerator: (value: any, key: string) => string): string
    set(collection: any, x?: (value: any, key?: any) => string): string {
        let expressions: string[]
        if (x === undefined) {
            expressions = _.map(collection, (value, name) => {
                if (name in this.attr) {
                    return `${this.attr[name]} = ${this.val(value)}`
                }
                return `${this.key[name]} = ${this.val(value)}`
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
    let valIndex = 1;
    const result = function (val: any, key?: string) {
        key = key ?? ":__val" + valIndex++;
        callback(key, val)
        return key
    }
    if (typeof values === "object") {
        for (const [key, value] of Object.entries(values as object)) {
            const dynamoKey = ":" + key
            Object.defineProperty(result, key, {
                get: function () {
                    callback(dynamoKey, value)
                    return dynamoKey
                }
            })
        }
    }

    return result as ValuesGenerator<T>
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

function isBasicDynamoType(x: DynamoDbType): x is DynamoDbBasicType {
    return typeof x === "string"
}

function isDynamoArray(x: DynamoDbType): x is DynamoDbArraySchema {
    return typeof x === "object" && '$array' in x
}

function isDynamoMap(x: DynamoDbType): x is DynamoDbMapSchema {
    return typeof x === "object" && '$map' in x
}

function isDynamoSchema(x: DynamoDbType): x is DynamoDbSchema {
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
 * Defines DynamoDB table or part of the table structure. Constructed using the {@link table} function.
 *
 * @example
 * //note use of `as const`, this is critical for the type inference to work.
 * const Table = table("MyTable",
 *      {pk: D.String, sk:D.Number} as const,
 *      {name:D.String, age:D.Number} as const)
 */
export interface Table<Key = any, Attributes = any> {
    /**
     * DynamoDB table name
     */
    readonly name: string
    /**
     * Key attributes (partition and sort key).
     */
    readonly key: DynamoDbSchemaType<Key>
    /**
     * Other than key attributes of the table.
     */
    readonly attributes: DynamoDbSchemaType<Attributes>
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
type DynamoDbSchemaType<T> = T extends DynamoDbSchema ? T : never
/**
 * Require T to be {@link Table}, otherwise yield `never`.
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
export type TableType<T> = Table<KeySchema<T>, AttributesSchema<T>>
/**
 * A key schema of the {@link Table}
 */
export type KeySchema<T> = T extends Table<any, any> ? T['key'] : never
/**
 * Attributes schema of the {@link Table}
 */
export type AttributesSchema<T> = T extends Table<any, any> ? T['attributes'] : never
/**
 * Combined key and attributes schema of the {@link Table}
 */
export type TableSchema<T> = T extends Table<any, any> ? (T['key'] & T['attributes']) : never

export type TableSchemaType<T extends Table<any, any>> = SchemaType<T['key']> & Partial<SchemaType<T['attributes']>>
export type AttributesSchemaType<T> = T extends Table<any, any> ? Partial<SchemaType<T['attributes']>> : never
export type KeySchemaType<T> = T extends Table<any, any> ? SchemaType<T['key']> : never

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
export function table<Key, Attributes>(name: string,
                                       key: DynamoDbSchemaType<Key>,
                                       attributes: DynamoDbSchemaType<Attributes>): Table<Key, Attributes> {
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
export type ExpressionGenerator<Table, V> = (context: {
    key: AttributeGenerator<KeySchema<Table>>,
    attr: AttributeGenerator<AttributesSchema<Table>>,
    val: ValuesGenerator<V>
}) => string

/**
 * Function generating a DynamoDB projection expression.
 * @param key - key attributes generator
 * @param attributes - non-key attributes generator
 * @return string - generated expression
 */
export type ProjectionGenerator<Table> = (context: {
    key: AttributeGenerator<KeySchema<Table>>,
    attr: AttributeGenerator<AttributesSchema<Table>>
}) => string[]

type SetExpression = string | Record<string, string> | (string | Record<string, string>)[];
/**
 * DynamoDB update expression
 */
type UpdateExpression = {
    set?: SetExpression,
    add?: string | string[],
    remove?: string | string[],
    delete?: string | string[],
}

export function updateExpression(exp: string | string[] | UpdateExpression) {
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
export type UpdateGenerator<Table, V> = (context: UpdateContext<Table, V>) => string | string[] | UpdateExpression


/**
 * Function generating a DynamoDB query key condition expression.
 * @param key - key attributes generator
 * @param val - context values passed to the command
 * @return string - generated expression
 */
export type KeyConditionGenerator<Table, V> = (context: {
    key: AttributeGenerator<KeySchema<Table>>,
    val: ValuesGenerator<V>
}) => string
/**
 * Function generating a DynamoDB query filter condition expression.
 * @param attributes - non-key attributes generator
 * @param val - context values passed to the command
 * @return string - generated expression
 */
export type FilterConditionGenerator<Table, V> = (context: {
    attr: AttributeGenerator<AttributesSchema<Table>>,
    val: ValuesGenerator<V>
}) => string
