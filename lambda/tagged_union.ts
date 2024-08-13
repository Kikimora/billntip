import {ValueError, ValueErrorType} from "@sinclair/typebox/errors";
import {TLiteral, TObject, Type, TypeGuard, Union} from "@sinclair/typebox";
import {Value} from "@sinclair/typebox/value";
import type {SchemaOptions, TSchema} from "@sinclair/typebox/build/require/type/schema";

/**
 * Creates tagged union type - a specialized union where each member has a tag property specifying type of the member.
 *
 * @example
 * const U = TaggedUnion([
 *  Type.Object({
 *      type:Type.Literal("point"),
 *      x: Type.Number(),
 *      y: Type.Number()
 *  }),
 *  Type.Object({
 *      type:Type.Literal("line"),
 *      x1: Type.Number(),
 *      y1: Type.Number(),
 *      x2: Type.Number(),
 *      y2: Type.Number()
 *  })],
 *  { tag:"type"})
 * interface UPoint { type: "point", x: number, y: number }
 * interface ULine { type: "line", x1: number, y1: number, x2: number, y2: number }
 * const point : UPoint = {
 *     type: "point", x: 0, y:0
 * } satisfies Static<typeof U>
 * const line: ULine = {
 *     type: "line",
 *     x1: 0, y1:0, x2: 10, y2:20,
 * } satisfies Static<typeof U>
 *
 * @param schemas - union members
 * @param options - union options, tag attribute is the key of the tag property.
 */
export function TaggedUnion<T extends TSchema[]>(schemas: [...T], options: SchemaOptions & {
    tag: keyof T[number]['properties']
}): Union<T> {
    return Type.Union(schemas, options);
}

/**
 * Default TypeBox union validation error leaves much to desire in terms of clarity. This method generates tagged union
 * validation error which is easier to understand.
 * @param error - validation error
 * @returns new error object describing problematic property or undefined if incoming error was not a union error.
 */
export function taggedUnionError(error: any): ValueError | undefined {
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