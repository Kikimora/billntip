import {MembershipItem} from "./store";
import {Static} from "@sinclair/typebox";
import {MemberSchema} from "@src/billntip/schemas";

export function keyToToken(key?: { pk: string, sk: string }) {
    if (key === undefined) return undefined
    return Buffer.from(JSON.stringify(key)).toString('base64url')
}

export function tokenToKey(token?: string) {
    if (token === undefined) return undefined
    return JSON.parse(Buffer.from(token, 'base64url').toString())
}

export function toMembership(x: MembershipItem): Static<typeof MemberSchema> {
    return ({
        accepted_at: x.accepted_at,
        invited_at: x.invited_at ?? 0,
        invited_by: x.invited_by ?? {
            username: "",
            first_name: "System",
            last_name: "",
            email: ""
        },
        org: x.org ?? {
            id: "",
            title: ""
        },
        rejected_at: x.rejected_at,
        role: x.role === "admin" ? "admin" : "member",
    });
}