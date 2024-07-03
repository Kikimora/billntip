
import {
    Type,
    attributeGenerator,
    Schema,
} from "@app/dynamodb/schema";

const SampleSchema = {
    numberArray: Type.Array(Type.Number),
    arrayOfArrays: Type.Array(Type.Array(Type.Number)),
    arrayOfArraysOfObjects: Type.Array(Type.Array({s: Type.String, n: Type.Number})),
    arrayOfNumberMaps: Type.Array(Type.Map(Type.Number)),
    arrayOfObjectMaps: Type.Array(Type.Map({s: Type.String, n: Type.Number})),
    numberMap: Type.Map(Type.Number),
    mapOfMaps: Type.Map(Type.Map({s: Type.String, n: Type.Number})),
    mapOfArrays: Type.Map(Type.Array(Type.Number)),
    mapOfObjects: Type.Map({s: Type.String, n: Type.Number}),
    mapOfObjectArrays: Type.Map(Type.Array({s: Type.String, n: Type.Number})),
    basic: Type.Number,
    obj: {
        s1: Type.String,
        n1: Type.Number,
        obj: {
            s2: Type.String,
            n2: Type.Number
        }
    }
} as const

// This is here to run type check and make sure SchemaType works

// eslint-disable-next-line @typescript-eslint/no-unused-vars
// noinspection JSUnusedLocalSymbols
const sampleObj: Schema<typeof SampleSchema> = {
    numberArray: [1],
    arrayOfArrays: [[1]],
    arrayOfArraysOfObjects: [[{s: "", n: 1}]],
    arrayOfNumberMaps: [{"s": 1}],
    arrayOfObjectMaps: [{"s": {s: "", n: 1}}],

    numberMap: {"key": 1},
    mapOfMaps: {"key": {"key": {s: "", n: 1}}},
    mapOfArrays: {"key": [1]},
    mapOfObjects: {"key": {s: "", n: 1}},
    mapOfObjectArrays: {"key": [{s: "", n: 1}]},

    basic: 1,
    obj: {
        s1: "",
        n1: 1,
        obj: {
            s2: "",
            n2: 1
        }
    }
}

describe("Attribute generator", () => {
    let expressionAttributes: Set<string>

    beforeEach(() => {
        expressionAttributes = new Set<string>()
    })

    const schema = attributeGenerator(SampleSchema, addToExpressionAttributes);

    it("Attributes", () => {
        expect(`${schema("key")}`).toBe("#key")
        expect(attrs()).toContainAllValues(["#key"])
    })

    it("Scalars", () => {
        expect(`${schema.basic}`).toBe("#basic")
        expect(attrs()).toContainAllValues(["#basic"])
    })

    it("Objects", () => {
        expect(`${schema.obj}`).toBe("#obj")
        expect(attrs()).toContainAllValues(["#obj"])
        expect(`${schema.obj.n1}`).toBe("#obj.#n1")
        expect(attrs()).toContainAllValues(["#obj", "#n1"])
        expect(`${schema.obj.obj}`).toBe("#obj.#obj")
        expect(attrs()).toContainAllValues(["#obj"])
        expect(`${schema.obj.obj.n2}`).toBe("#obj.#obj.#n2")
        expect(attrs()).toContainAllValues(["#obj", "#n2"])
    })

    describe("Array", () => {

        it("of scalars", () => {
            expect(`${schema.numberArray}`).toBe("#numberArray")
            expect(attrs()).toContainAllValues(["#numberArray"])
            expect(`${schema.numberArray(1)}`).toBe("#numberArray[1]")
            expect(attrs()).toContainAllValues(["#numberArray"])
        })
        it("of maps", () => {
            expect(`${schema.arrayOfNumberMaps}`).toBe("#arrayOfNumberMaps")
            expect(attrs()).toContainAllValues(["#arrayOfNumberMaps"])
            expect(`${schema.arrayOfNumberMaps(1)}`).toBe("#arrayOfNumberMaps[1]")
            expect(attrs()).toContainAllValues(["#arrayOfNumberMaps"])
        })
        it("of maps", () => {
            expect(`${schema.arrayOfObjectMaps(1)}`).toBe("#arrayOfObjectMaps[1]")
            expect(attrs()).toContainAllValues(["#arrayOfObjectMaps"])
            expect(`${schema.arrayOfObjectMaps(1)("key")}`).toBe("#arrayOfObjectMaps[1].#key")
            expect(attrs()).toContainAllValues(["#arrayOfObjectMaps", "#key"])
            expect(`${schema.arrayOfObjectMaps(1)("key").s}`).toBe("#arrayOfObjectMaps[1].#key.#s")
            expect(attrs()).toContainAllValues(["#arrayOfObjectMaps", "#key", "#s"])
        })
        it("of arrays of objects", () => {
            expect(`${schema.arrayOfArraysOfObjects(1)}`).toBe("#arrayOfArraysOfObjects[1]")
            expect(attrs()).toContainAllValues(["#arrayOfArraysOfObjects"])
            expect(`${schema.arrayOfArraysOfObjects(1)(1)}`).toBe("#arrayOfArraysOfObjects[1][1]")
            expect(attrs()).toContainAllValues(["#arrayOfArraysOfObjects"])
            expect(`${schema.arrayOfArraysOfObjects(1)(1).s}`).toBe("#arrayOfArraysOfObjects[1][1].#s")
            expect(attrs()).toContainAllValues(["#arrayOfArraysOfObjects", "#s"])
        })
    })

    describe("Map", () => {
        it("of scalars", () => {
            expect(`${schema.numberMap}`).toBe("#numberMap")
            expect(attrs()).toContainAllValues(["#numberMap"])
            expect(`${schema.numberMap("key")}`).toBe("#numberMap.#key")
            expect(attrs()).toContainAllValues(["#numberMap", "#key"])
        })

        it("of maps", () => {
            expect(`${schema.mapOfMaps}`).toBe("#mapOfMaps")
            expect(attrs()).toContainAllValues(["#mapOfMaps"])
            expect(`${schema.mapOfMaps("key")}`).toBe("#mapOfMaps.#key")
            expect(attrs()).toContainAllValues(["#mapOfMaps", "#key"])
            expect(`${schema.mapOfMaps("key")("key")}`).toBe("#mapOfMaps.#key.#key")
            expect(attrs()).toContainAllValues(["#mapOfMaps", "#key"])
            expect(`${schema.mapOfMaps("key")("key").s}`).toBe("#mapOfMaps.#key.#key.#s")
            expect(attrs()).toContainAllValues(["#mapOfMaps", "#key", "#s"])
        })

        it("of objects", () => {
            expect(`${schema.mapOfObjects}`).toBe("#mapOfObjects")
            expect(attrs()).toContainAllValues(["#mapOfObjects"])
            expect(`${schema.mapOfObjects("key")}`).toBe("#mapOfObjects.#key")
            expect(attrs()).toContainAllValues(["#mapOfObjects", "#key"])
            expect(`${schema.mapOfObjects("key").n}`).toBe("#mapOfObjects.#key.#n")
            expect(attrs()).toContainAllValues(["#mapOfObjects", "#key", "#n"])
        })

        it("of arrays of scalars", () => {
            expect(`${schema.mapOfArrays}`).toBe("#mapOfArrays")
            expect(attrs()).toContainAllValues(["#mapOfArrays"])
            expect(`${schema.mapOfArrays("key")}`).toBe("#mapOfArrays.#key")
            expect(attrs()).toContainAllValues(["#mapOfArrays", "#key"])
            expect(`${schema.mapOfArrays("key")(1)}`).toBe("#mapOfArrays.#key[1]")
            expect(attrs()).toContainAllValues(["#mapOfArrays", "#key"])
        })
        it("of arrays of objects", () => {
            expect(`${schema.mapOfObjectArrays}`).toBe("#mapOfObjectArrays")
            expect(attrs()).toContainAllValues(["#mapOfObjectArrays"])
            expect(`${schema.mapOfObjectArrays("key")}`).toBe("#mapOfObjectArrays.#key")
            expect(attrs()).toContainAllValues(["#mapOfObjectArrays", "#key"])
            expect(`${schema.mapOfObjectArrays("key")}`).toBe("#mapOfObjectArrays.#key")
            expect(attrs()).toContainAllValues(["#mapOfObjectArrays", "#key"])
            expect(`${schema.mapOfObjectArrays("key")(1)}`).toBe("#mapOfObjectArrays.#key[1]")
            expect(attrs()).toContainAllValues(["#mapOfObjectArrays", "#key"])
            expect(`${schema.mapOfObjectArrays("key")(1).s}`).toBe("#mapOfObjectArrays.#key[1].#s")
            expect(attrs()).toContainAllValues(["#mapOfObjectArrays", "#key", "#s"])
        })
    })

    function attrs() {
        const a = Array.from(expressionAttributes)
        expressionAttributes.clear()
        return a
    }

    function addToExpressionAttributes(path: string[]) {
        path.filter(x => x.startsWith('#')).forEach(x => expressionAttributes.add(x))
    }
})
