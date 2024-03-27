import upath from "upath";
import fs from "fs";
import {IsEqual} from "type-fest";

export function resources() {
    const o = upath.join(__dirname, "..", "aws", "resources.json")
    return JSON.parse(fs.readFileSync(o).toString("utf-8"))
}

export function StaticAssert<T1, T2>() {
    return {
        is() {
        },
    } as { is(x: IsEqual<T1, T2>): void }
}