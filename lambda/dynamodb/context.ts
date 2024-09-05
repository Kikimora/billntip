import {convertToAttr} from "@aws-sdk/util-dynamodb";
import * as ddb from "@aws-sdk/client-dynamodb";
import {internalError} from "@app/lambda";
import _ from "lodash";
import {Schema} from "type-fest";
import * as DDB from "./schema";

class CommandContext<Key, Attributes> {

    private _attributes?: Record<string, string>
    private _values?: Record<string, ddb.AttributeValue>

    public get attributes() {
        return !_.isEmpty(this._attributes) ? this._attributes : undefined
    }

    public get values() {
        return !_.isEmpty(this._values) ? this._values : undefined
    }

    private readonly key: TKey<Key>
    private readonly attr: TAttr<Attributes>

    constructor(schema: DDB.Schema, private readonly marshalOptions: { removeUndefinedValues: boolean }) {
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

        this.key = keyGenerator(schema.key, keyCallback)
        this.attr = attributeGenerator(schema.item, attrCallback)
    }

    begin<V>(values: V, marshalledValues?: Record<string, ddb.AttributeValue>): {
        attr: TAttr<Attributes>,
        key: TKey<Key>,
        ref: Values<V>
    }
    begin(): { attr: TAttr<Attributes>, key: TKey<Key> }
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
                key,
                attr,
                ref: refGenerator(values, addToValues)
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
 * Mirrors shape of a key {@link DDB.Schema} with props generating DynamoDb attributes.
 * @example (MySchema described in the example section [here]{@link DDB.Schema})
 * const key = keyGenerator(MySchema)
 * console.log(user.pk) //logs #pk
 */
export type TKey<T> = Schema<T, string>

/**
 * Mirrors shape of a {@link DDB.Schema} with props and functions generating DynamoDb attributes.
 * @example (MySchema described in the example section [here]{@link DDB.Schema})
 * const user = attributeGenerator(MySchema)
 * console.log(user.uid) //logs #uid
 * console.log(user.profile.firstName) //logs #profile.#firstName
 * console.log(user.recentTransactions(1).amount) //logs #recentTransactions[1].#amount
 * console.log(user.pictures('50x50')) //logs #pictures.#50x50
 */
//<!-- formatter: off -->
export type TAttr<T> =
      T extends string ? string
    : T extends Map<unknown, infer E> ? (idx:string)=> TAttr<E> & StringBuilder
    : T extends Set<unknown> ? string
    : T extends ReadonlyMap<unknown, infer E> ? (idx:string)=> TAttr<E> & StringBuilder
    : T extends ReadonlySet<unknown>? string
    : T extends ReadonlyArray<infer E> ? (idx:number)=> TAttr<E> & StringBuilder
    : T extends Array<infer E> ? (idx:number)=> TAttr<E> & StringBuilder
    : T extends object ? _TAttr<T>
    : never;

type _TAttr<ObjectType extends object> = {
    [KeyType in keyof ObjectType]-?: TAttr<ObjectType[KeyType]>;
};
type ValuesKeys<T> = T extends Record<string, any> ? keyof T & string
                   : T extends Record<string, any> | undefined ? keyof T & string
                   : never
//<!-- @formatter: on -->


/**
 * Helper function to generate property values for the DynamoDB expressions. See {@link refGenerator} for details.
 */
export interface Values<T> {
    /**
     * Reference named value from values, items or similar part of the DynamoDB expression.
     * @param key value key
     */
    (key: ValuesKeys<T>): string

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
        const hasValues = function (key: ValuesKeys<T>) {
            const valueKey = ':' + key
            callback(valueKey, values[key as keyof T])
            return valueKey
        }
        hasValues.val = val
        generator = hasValues
    } else {
        const noValues = function (key: ValuesKeys<T>) {
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
 * Create {@link TAttr} for a given DDB.
 * @param schema - attributes schema
 * @param callback - callback function to call each time an attribute generated.
 */
export function attributeGenerator(schema: DDB.TDynamoAttribute, callback?: (path: string[]) => void) {

    const attr = function (attributeName: string) {
        return new Builder(attributeName, undefined, callback)
    }
    attr.toString = function (this: BuilderHolder) {
        return this[__builder]?.toString() ?? ""
    }

    if (schema === null || !DDB.isDynamoItem(schema))
        return attr as any


    for (const [key, type] of Object.entries(schema.properties)) {
        if (DDB.isBasicDynamoType(type)) {
            Object.defineProperty(attr, key, {
                get: function (this: BuilderHolder) {
                    const builder = new Builder(key, this[__builder], callback);
                    return builder.toString()
                }
            })
        }

        if (DDB.isDynamoMap(type) || DDB.isDynamoArray(type)) {
            const collectionFn = collection(type)
            Object.defineProperty(attr, key, {
                get: function (this: BuilderHolder) {
                    const builder = new Builder(key, this[__builder], callback)
                    return collectionFn.item(builder)
                }
            })
        }

        if (DDB.isDynamoItem(type)) {
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

type CollectionAttributes<T> = { item(builder: Builder): TAttr<T> }

function collectionItemType<T extends DDB.TDynamoArray | DDB.TDynamoMap>(collectionType: T): DDB.TDynamoAttribute {
    if (DDB.isDynamoArray(collectionType)) return collectionType.items
    const rec = collectionType.patternProperties
    return Object.values(rec)[0]
}

function collection<T extends DDB.TDynamoArray | DDB.TDynamoMap>(col: T): CollectionAttributes<T> {
    let itemType = collectionItemType(col)
    let value: any
    if (DDB.isBasicDynamoType(itemType)) {
        value = function (this: Builder, idx: string | number) {
            return new Builder(idx, this)
        }
    }

    if (DDB.isDynamoMap(itemType) || DDB.isDynamoArray(itemType)) {
        const attrs = collection(itemType)
        value = function (this: Builder, idx: string | number) {
            return attrs.item(new Builder(idx, this))
        }
    }

    if (DDB.isDynamoItem(itemType)) {
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

function keyGenerator(schema: DDB.TDynamoKey, callback?: (path: string) => void) {
    if (schema === null || typeof schema !== "object")
        throw new Error("Invalid schema")

    const attr = {}
    for (const key of Object.keys(schema.properties)) {
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

export default CommandContext;
