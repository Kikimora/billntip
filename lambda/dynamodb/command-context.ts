import {convertToAttr} from "@aws-sdk/util-dynamodb";
import * as ddb from "@aws-sdk/client-dynamodb";
import * as schemas from "./schema";
import {
    DynamoDbArraySchema,
    DynamoDbMapSchema, DynamoDbSchema, DynamoDbType,
    isBasicDynamoType,
    isDynamoArray,
    isDynamoMap,
    isDynamoSchema,
    schema
} from "./schema";
import {internalError} from "@app/lambda";
import _ from "lodash";


class CommandContext<T extends schema.TableSchema> {

    private _attributes?: Record<string, string>
    private _values?: Record<string, ddb.AttributeValue>

    public get attributes() {
        return !_.isEmpty(this._attributes) ? this._attributes : undefined
    }

    public get values() {
        return !_.isEmpty(this._values) ? this._values : undefined
    }

    private readonly key: KeyAttributes<T>
    private readonly attr: ItemAttributes<T>

    constructor(keySchema: schema.KeySchema<T>,
                attributeSchema: schema.AttributesSchema<T>,
                private readonly marshalOptions: { removeUndefinedValues: boolean }) {

        const attrCallback = (path: string[]) => {
            for (const p of path) {
                if (p.startsWith("#")) {
                    this._attributes![p] = p.substring(1)
                }
            }
        }

        const keyCallback = (key: string) => {
            this._attributes![key] = key.substring(1)
        }

        this.key = keyGenerator(keySchema, keyCallback)
        this.attr = attributeGenerator(attributeSchema, attrCallback)
    }

    begin<V>(values: V, marshalledValues?: Record<string, ddb.AttributeValue>): {
        attr: ItemAttributes<T>,
        key: KeyAttributes<T>,
        ref: Values<V>
    }
    begin(): { attr: ItemAttributes<T>, key: KeyAttributes<T> }
    begin(values?: any, marshalledValues?: Record<string, ddb.AttributeValue>): any {
        const {key, attr, marshalOptions} = this
        this._attributes = {}
        if (arguments.length >= 1) {
            const valueRefs = this._values = {} as Record<string, ddb.AttributeValue>

            function addToValues(key: string, val: any) {
                valueRefs[key] = marshalledValues?.[key.slice(1)] ?? (
                    val === undefined ? {NULL: true} : convertToAttr(val, marshalOptions)
                )
            }

            return {
                key, attr, ref: refGenerator(values, addToValues)
            }
        } else {
            return {
                key, attr
            }
        }
    }

    end() {
        if (this._attributes === undefined)
            throw internalError("Invalid command context state")
        this._attributes = undefined
        this._values = undefined
    }

}

//<!-- @formatter:off -->

/**
 * Mirrors shape of a key {@link DynamoDbSchema} with props generating DynamoDb attributes.
 * @example (MySchema described in the example section [here]{@link DynamoDbSchema})
 * const key = keyGenerator(MySchema)
 * console.log(user.pk) //logs #pk
 */
export type KeyAttributes<T extends schema.TableSchema> =_KeyAttributes<schema.KeySchema<T>>
type _KeyAttributes<T> = { [key in keyof T]: string }

/**
 * Mirrors shape of a {@link DynamoDbSchema} with props and functions generating DynamoDb attributes.
 * @example (MySchema described in the example section [here]{@link DynamoDbSchema})
 * const user = attributeGenerator(MySchema)
 * console.log(user.uid) //logs #uid
 * console.log(user.profile.firstName) //logs #profile.#firstName
 * console.log(user.recentTransactions(1).amount) //logs #recentTransactions[1].#amount
 * console.log(user.pictures('50x50')) //logs #pictures.#50x50
 */
export type ItemAttributes<T extends schema.TableSchema> = _ItemAttributes<schema.AttributesSchema<T>>
type _ItemAttributes<T> = (
      T extends schemas.DynamoDbBasicType ? string
    : T extends schemas.DynamoDbArraySchema ? (idx:number)=> _ItemAttributes<T['$array']> & StringBuilder
    : T extends schemas.DynamoDbMapSchema ? (idx:string)=> _ItemAttributes<T['$map']> & StringBuilder
    : T extends schemas.DynamoDbSchema ? { [k in KeyOf<T>]: _ItemAttributes<T[k]> & StringBuilder; }
    : T extends string ? T
    : never
    )
    & ((val: string) => string)

//<!-- @formatter:on -->

/**
 * Helper function to generate property values for the DynamoDB expressions. See {@link refGenerator} for details.
 */
export interface Values<T> {
    /**
     * Reference named value from values, items or similar part of the DynamoDB expression.
     * @param key value key
     */
    (key: keyof NonNullable<T> & string): string

    /**
     * Create DynamoDB expression variable named `__valN` with a given value. N starts with 1.
     * @param value value to assign to a new variable.
     */
    val(value: any): string
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
function refGenerator<T>(values: T, callback: (key: string, value: any) => void): Values<T> {
    let valIndex = 1
    const val = function (value: any) {
        const valueKey = ':__val' + valIndex++
        callback(valueKey, value)
        return valueKey
    }
    let generator
    if (values !== undefined && values !== null) {
        const hasValues = function (key: keyof NonNullable<T> & string) {
            const valueKey = ':' + key
            callback(valueKey, values[key])
            return valueKey
        }
        hasValues.val = val
        generator = hasValues
    } else {
        const noValues = function (key: keyof NonNullable<T> & string) {
            const valueKey = ':' + key
            callback(valueKey, undefined)
            return valueKey
        }
        noValues.val = val
        generator = noValues
    }
    return generator
}

/**
 * Create {@link ItemAttributes} for a given schema.
 * @param schema - attributes schema
 * @param callback - callback function to call each time an attribute generated.
 */
export function attributeGenerator<T>(schema: T, callback?: (path: string[]) => void): _ItemAttributes<T> {
    const attr = function (attributeName: string) {
        return new Builder(attributeName, undefined, callback)
    }
    attr.toString = function (this: BuilderHolder) {
        return this[__builder]?.toString() ?? ""
    }

    if (schema === null || typeof schema !== "object")
        return attr as any

    for (const [key, type] of Object.entries(schema)) {
        if (schemas.isBasicDynamoType(type)) {
            Object.defineProperty(attr, key, {
                get: function (this: BuilderHolder) {
                    const builder = new Builder(key, this[__builder], callback);
                    return builder.toString()
                }
            })
        }

        if (schemas.isDynamoMap(type) || schemas.isDynamoArray(type)) {
            const collectionFn = collection(type)
            Object.defineProperty(attr, key, {
                get: function (this: BuilderHolder) {
                    const builder = new Builder(key, this[__builder], callback)
                    return collectionFn.item(builder)
                }
            })
        }

        if (schemas.isDynamoSchema(type)) {
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

type KeyOf<T> = Exclude<keyof T, symbol>

/**
 * Anything with `toString()` method.
 */
interface StringBuilder {
    toString(): string,

    valueOf(): any
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

type CollectionAttributes<T> = { item(builder: Builder): _ItemAttributes<T> }

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

function keyGenerator<T>(schema: T, callback?: (path: string) => void): _KeyAttributes<T> {
    if (schema === null || typeof schema !== "object")
        throw new Error("Invalid schema")

    const attr = {}
    for (const key of Object.keys(schema)) {
        const x = "#" + key
        Object.defineProperty(attr, key, {
            get: function () {
                callback?.(x)
                return x
            }
        })
    }
    return attr as any
}

//See https://youtrack.jetbrains.com/issue/WEB-68793/Member-variable-incorrectly-highlighted-as-unused
export default CommandContext;
