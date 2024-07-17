import {ValueErrorType} from "@sinclair/typebox/errors";
import {TLiteral, TObject, Type, TypeGuard, Union} from "@sinclair/typebox";
import {Value} from "@sinclair/typebox/value";
import type {SchemaOptions, TSchema} from "@sinclair/typebox/build/require/type/schema";

export function TaggedUnion<T extends TSchema[]>(schemas: [...T], options: SchemaOptions & {tag:keyof T[number]['properties']}): Union<T> {
    return Type.Union(schemas, options);
}

export function specializeUnionError(error: any) {
    if (error === undefined) return error
    const {schema, path, value, type} = error

    if (typeof path !== 'string') return error
    const isUnionError = type === ValueErrorType.Union && TypeGuard.IsUnion(schema)
    if (!isUnionError) return error
    const {tag, anyOf: members} = schema
    const isDiscriminatedUnion = typeof tag === 'string' && typeof value === 'object' && value !== null && tag in value
    if (!isDiscriminatedUnion) return error
    const tagValue = value[tag as keyof typeof value]
    if (tagValue === undefined) return error

    let member: TObject | undefined
    let literals: TLiteral[] = []
    for (const schema of members) {
        if (TypeGuard.IsObject(schema)) {
            const value = schema.properties[tag]
            if (TypeGuard.IsLiteral(value)) {
                literals.push(value)
                if (value.const === tagValue) {
                    member = schema
                }
            }
        }
    }

    if (member !== undefined) {
        const errors = Value.Errors(member, value)
        const error = errors.First()
        if (error !== undefined) {
            error.path = path + error.path
            return error
        }
    } else {
        const tags = Type.Union(literals)
        const errors = Value.Errors(tags, tagValue)
        const error = errors.First()
        if (error !== undefined) {
            error.path = path + '/' + tag
            return error
        }
    }
    return error
}