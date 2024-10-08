import * as Type from "@sinclair/typebox";
import {Static} from "@sinclair/typebox";
import {UnionToIntersection} from "type-fest";

export const String = Type.String()
export const Number = Type.Number()
export const Binary = Type.Uint8Array()
export const Boolean = Type.Boolean()
export const Null = Type.Null()
export const Array = Type.Array
export const Map = function <T extends TDynamoAttribute>(schema: T) {
    return Type.Record(String, schema)
}
export const Item = function <T extends Record<string, TDynamoAttribute>>(props: T, options?: Type.ObjectOptions) {
    return Type.Object(props, options)
}
export const Key = function <T extends Record<string, TDynamoKeyType>>(props: T, options?: Type.ObjectOptions) {
    return Type.Object(props, options)
}
export const TemplateLiteral = Type.TemplateLiteral
export const Literal = Type.Literal
export const Union = Type.Union
export const StringSet = Type.Unsafe<Set<string>>({type: 'set'})
export const NumberSet = Type.Unsafe<Set<number>>({type: 'set'})
export const BinarySet = Type.Unsafe<Set<Uint8Array>>({type: 'set'})
export const Optional = Type.Optional
export const Partial = Type.Partial
export const Required = Type.Required

/**
 * Convert {a:string} & {b:number} into {a:string, b:number}
 */
export type Id<T> = {} & { [P in keyof T]: T[P] }

export const Merge = function <const T extends TDynamoItem>(items: T[]) {
    type Intersection = UnionToIntersection<T['properties']>
    type PlainObject = Id<Intersection>

    const props = items.reduce(function (acc, item) {
        acc = {
            ...acc,
            ...item.properties
        }
        return acc
    }, {})
    return Item(props) as Type.TObject<PlainObject>
}

export type TDynamoKeyType = Type.TString
    | Type.TTemplateLiteral
    | Type.TLiteral
    | Type.TNumber
    | Type.TUint8Array

export type TDynamoAttribute = TDynamoValue | TDynamoArray | TDynamoMap | TDynamoItem
export type TDynamoValue =
    Type.TString
    | Type.TTemplateLiteral
    | Type.TLiteral
    | Type.TNumber
    | Type.TUint8Array
    | Type.TBoolean
    | Type.TUnion
    | typeof StringSet
    | typeof NumberSet
    | typeof BinarySet
export type TDynamoArray = Type.TArray<TDynamoAttribute>
export type TDynamoItem = Type.TObject<Record<string, TDynamoAttribute>>
export type TDynamoMap = Type.TRecord<Type.TString, TDynamoAttribute>
export type TDynamoKey = Type.TObject<Record<string, TDynamoKeyType>>

export interface Schema {
    key: TDynamoKey
    item: TDynamoItem
}

export type SchemaKeyType<T extends Schema> = Static<T['key']>
export type SchemaItemType<T extends Schema> = Static<T['item']>
export type SchemaType<T extends Schema> = SchemaKeyType<T> & SchemaItemType<T>

export function isBasicDynamoType(x: TDynamoAttribute): x is TDynamoValue {
    switch (x.type) {
        case 'string':
        case 'number':
        case 'boolean':
        case 'set':
        case 'uint8array':
            return true
        default:
            return false
    }
}

export function isDynamoArray(x: TDynamoAttribute): x is TDynamoArray {
    return x.type === 'array'
}

export function isDynamoMap(x: TDynamoAttribute): x is TDynamoMap {
    return x[Type.Kind] === 'Record'
}

export function isDynamoItem(x: TDynamoAttribute): x is TDynamoItem {
    return x[Type.Kind] === 'Object'
}

export function schema<const Key extends Record<string, TDynamoKeyType>, const Item extends Record<string, TDynamoAttribute>>(key: Key, item: Item) {
    return {
        key: Type.Object(key),
        item: Type.Object(item)
    } as const
}
