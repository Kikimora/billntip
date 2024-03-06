import vm from 'node:vm';

function containsInArray(value: any, array: any[]) {
    for (let i = 0; i < array.length; ++i) {
        if (array[i] === value) return true
    }
    return false
}

const Operators = ["gt", "gte", "lt", "lte", "startsWith", "endsWith", "and", "or", "not"] as const
const MatcherKeys = Operators.map(x => '$' + x)
type OperatorType = `$${typeof Operators[number]}`

type PrimitiveMatcher = string | number | boolean | null
type ArrayMatcher = Array<any>
type OperatorMatcher = { [key in OperatorType]?: any }
type Matcher = PrimitiveMatcher | ArrayMatcher | OperatorMatcher

function isArrayMatcher(value: any): value is ArrayMatcher {
    return Array.isArray(value)
}

function isMatcher(value: any): value is Matcher {
    return isOperatorMatcher(value) || isPrimitiveMatcher(value) || isArrayMatcher(value)
}

function isPrimitiveMatcher(value: any): value is PrimitiveMatcher {
    const type = typeof value
    return type === "string" || type === "number" || type == "boolean" || value === null
}

function isOperatorMatcher(value: any): value is Matcher {
    if (typeof value !== "object" || value == null) return false
    const keys = Object.keys(value)
    const knownMatcher = keys.length == 1 && MatcherKeys.indexOf(keys[0]) >= 0
    if (!knownMatcher) return false
    const matcher = value[keys[0]];
    if (!isMatcher(matcher))
        throw new Error("Unknown matcher '" + JSON.stringify(matcher) + "'")
    return true
}

function compileMatcher(matcher: Matcher, variable: string): string {

    if (isPrimitiveMatcher(matcher)) {
        return `(${variable} === ${JSON.stringify(matcher)})`
    }

    if (isArrayMatcher(matcher)) {
        return `(containsInArray(${variable}, ${JSON.stringify(matcher)}))`
    }

    if ('$gt' in matcher) {
        if (typeof matcher.$gt !== "number") throw new Error(`Invalid matcher '${matcher}}': $gt parameter must be a number`)
        return `(typeof ${variable} == "number" && ${variable} > ${JSON.stringify(matcher.$gt)})`
    }
    if ('$gte' in matcher) {
        if (typeof matcher.$gte !== "number") throw new Error(`Invalid matcher '${matcher}}': $gte parameter must be a number`)
        return `(typeof ${variable} == "number" && ${variable} >= ${JSON.stringify(matcher.$gte)})`
    }
    if ('$lt' in matcher) {
        if (typeof matcher.$lt !== "number") throw new Error(`Invalid matcher '${matcher}}': $lt parameter must be a number`)
        return `(typeof ${variable} == "number" && ${variable} < ${JSON.stringify(matcher.$lt)})`
    }
    if ('$lte' in matcher) {
        if (typeof matcher.$lte !== "number") throw new Error(`Invalid matcher '${matcher}}': $lte parameter must be a number`)
        return `(typeof ${variable} == "number" && ${variable} <= ${JSON.stringify(matcher.$lte)})`
    }
    if ('$startsWith' in matcher) {
        if (typeof matcher.$startsWith !== "string") throw new Error(`Invalid matcher '${matcher}}': $startsWith parameter must be a string`)
        return `(typeof ${variable} == "string" && ${variable}.startsWith(${JSON.stringify(matcher.$startsWith)}))`
    }
    if ('$endsWith' in matcher) {
        if (typeof matcher.$endsWith !== "string") throw new Error(`Invalid matcher '${matcher}}': $endsWith parameter must be a string`)
        return `(typeof ${variable} == "string" && ${variable}.endsWith(${JSON.stringify(matcher.$endsWith)}))`
    }
    if ('$not' in matcher) {
        if (!isMatcher(matcher.$not)) throw new Error(`Invalid matcher '${matcher}}': $not parameter must be a valid matcher`)
        return `(!${compileMatcher(matcher.$not, variable)})`
    }
    if ('$and' in matcher) {
        if (!Array.isArray(matcher.$and)) throw new Error(`Invalid matcher '${matcher}}': $and parameter must be array`)
        if (matcher.$and.length < 2) throw new Error(`Invalid matcher '${matcher}}': $and parameter must have at least 2 values`)
        matcher.$and.forEach(function (x) {
            if (!isMatcher(x)) throw new Error(`Invalid matcher '${matcher}}': $and parameters must be valid matchers`)
        })
        return "(" + matcher.$and.map(function (m) {
            return compileMatcher(m, variable)
        }).join(' && ') + ")"
    }
    if ('$or' in matcher) {
        if (!Array.isArray(matcher.$or)) throw new Error(`Invalid matcher '${matcher}}': $or parameter must be array`)
        if (matcher.$or.length < 2) throw new Error(`Invalid matcher '${matcher}}': $or parameter must have at least 2 values`)
        matcher.$or.forEach(function (x) {
            if (!isMatcher(x)) throw new Error(`Invalid matcher '${matcher}}': $or parameters must be valid matchers`)
        })

        return "(" + matcher.$or.map(function (m) {
            return compileMatcher(m, variable)
        }).join(' || ') + ")"
    }

    throw new Error("Unknown matcher '" + JSON.stringify(matcher) + "'")
}

function compileSchemaBody(schema: Schema, prefix: string, options: { level: number, debug: boolean }) {
    let code = ""
    const indent = function (s: string) {
        return `\n${'\t'.repeat(options.level)}${s}`
    }
    for (const [key, value] of Object.entries(schema)) {
        code += indent(`const ${prefix}_${key} = ${prefix}?.${key}`)
        if (isMatcher(value)) {
            if (options.debug) {
                code += indent(`console.log("${prefix}_${key}", ${prefix}_${key}, ${JSON.stringify(value)})`)
            }
            code += indent(`if (!${compileMatcher(value, `${prefix}_${key}`)}) return false;`)
        } else {
            code += compileSchemaBody(value, `${prefix}_${key}`, options)
        }
    }
    return code
}

const ctx = vm.createContext({containsInArray, console})

/**
 * Type of schema definition.
 * @example
 * const sampleSchema : Schema = {
 *     primitives: {
 *         str: "test string",
 *         num: 1,
 *         bool: true,
 *         n: null,
 *     },
 *     arr: ["uid1", "uid2"],
 *     operators: {
 *         a: {$gt: 1},
 *         b: {$gte: 1},
 *         c: {$lt: 1},
 *         d: {$lte: 1},
 *         e: {$startsWith: "abc"},
 *         f: {$endsWith: "xyz"},
 *         g: {$and: [{$gt: 2}, {$lt: 10}]},
 *         h: {$or: [1, {$lt: 1}, {$startsWith: "abc"}]},
 *         i: {$not: 1},
 *         j: {$not: {$lt: 1}},
 *         k: {$not: {$and: [{$lt: 10}, {$gt: 1}]}},
 *         l: {$not: [1, 2]},
 *     }
 * }
 */
export type Schema = { [key: string]: Schema | Matcher }
export type CompiledSchema = (value: any) => boolean

/**
 * Compiles schema definition into a function matching provided object against the schema.
 * @param schema - schema definition
 * @param debug - if true then print compilation performance details, generated function body and inject lots of 'console.log' statements into the generated function.
 */
export function compileSchema(schema: Schema, debug: boolean = false): CompiledSchema {
    const start = performance.now()
    const code = compileSchemaBody(schema, "value", {level: 1, debug})
    const fn = `function match(value) {${code}\n\treturn true;\n}`
    vm.runInContext(fn, ctx, {
        lineOffset: 0, columnOffset: 0, filename: "gen.js"
    })
    const end = performance.now()
    if (debug) {
        console.info('Compiled schema in ', end - start, ' ms')
        console.log(fn)
    }
    return ctx.match
}
