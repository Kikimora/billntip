import * as ddb from "@aws-sdk/client-dynamodb";
import {convertToAttr} from "@aws-sdk/util-dynamodb";
import {attributeGenerator, TableType, valueGenerator} from "./schema";


export function prepareCommand<T extends TableType<T>, V>(tbl: T,
                                                          context: V,
                                                          marshalledValues?: Record<string, ddb.AttributeValue>) {
    const attributeNames: Record<string, string> = {}
    const attributeValues: Record<string, ddb.AttributeValue> = {}

    function addToAttributes(path: string[]) {
        for (const p of path) {
            if (p.startsWith("#")) {
                attributeNames[p] = p.substring(1)
            }
        }
    }

    function addToValues(key: string, val: any) {
        attributeValues[key] = marshalledValues?.[key.slice(1)] ?? (
            val === undefined ? {NULL: true} : convertToAttr(val, MarshalOptions)
        )
    }

    return {
        attributeNames,
        attributeValues,
        key: attributeGenerator(tbl.key, addToAttributes),
        attr: attributeGenerator(tbl.attributes, addToAttributes),
        ref: valueGenerator(context, addToValues)
    };
}

export const MarshalOptions = {
    removeUndefinedValues: true
}