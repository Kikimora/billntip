import {Schema, compileSchema} from "@app/diagnostics/matcher";

const testSchema: Schema = {
    primitives: {
        str: "test string",
        num: 1,
        bool: true,
        n: null,
    },
    arr: ["uid1", "uid2"],
    operators: {
        a: {$gt: 1},
        b: {$gte: 1},
        c: {$lt: 1},
        d: {$lte: 1},
        e: {$startsWith: "abc"},
        f: {$endsWith: "xyz"},
        g: {$and: [{$gt: 2}, {$lt: 10}]},
        h: {$or: [1, {$lt: 1}, {$startsWith: "abc"}]},
        i: {$not: 1},
        j: {$not: {$lt: 1}},
        k: {$not: {$and: [{$lt: 10}, {$gt: 1}]}},
        l: {$not: [1, 2]},
    }
}

const testValue = {
    primitives: {
        str: "test string",
        num: 1,
        bool: true,
        n: null,
    },
    arr: "uid1",
    operators: {
        a: 2,
        b: 1,
        c: 0,
        d: 1,
        e: "abcde",
        f: "uvwxyz",
        g: 3,
        h: "abcde",
        i: 2,
        j: 2,
        k: 11,
        l: 3
    }
}

describe("matcher", () => {
    it("compiles schema", () => {
        expect(function () { compileSchema(testSchema, true) }).not.toThrow()
    })

    it("returns true if object matches", () => {
        const fn = compileSchema(testSchema, true)
        expect(fn(testValue)).toBeTrue()
    })

    it("returns false if object does not match", () => {
        const fn = compileSchema(testSchema, true)
        expect(fn({primitives: {str: "xxx"}})).toBeFalse()
    })

    it.each([
        [{$gt: "string"}],
        [{$gte: "string"}],
        [{$lt: "string"}],
        [{$lte: "string"}],
        [{$startsWith: 1}],
        [{$endsWith: 1}],
        [{$and: 1}],
        [{$and: []}],
        [{$and: [{$aaa: 1}]}],
        [{$or: 1}],
        [{$or: []}],
        [{$or: [{$aaa: 1}]}],
        [{$not: {}}],
    ])("%j is an invalid matcher", (x) => {
        expect(function () {
            compileSchema({matcher: x}, true)
        }).toThrow()
    })
})