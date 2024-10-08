import {MemberItem, Org, LocationItem} from "./store";
import {Static} from "@sinclair/typebox";
import {MemberSchema} from "@src/billntip/schemas";
import * as schemas from "@src/billntip/schemas";
import {UserItem as Profile} from "@src/users/user";

export function keyToToken(key?: { pk: string, sk: string }) {
    if (key === undefined) return undefined
    return Buffer.from(JSON.stringify(key)).toString('base64url')
}

export function tokenToKey(token?: string) {
    if (token === undefined) return undefined
    return JSON.parse(Buffer.from(token, 'base64url').toString())
}

interface MemberOrg {
    id: string
    title?: string
}

export function toMembership(x: MemberItem, org: MemberOrg, user?: Profile, invitedBy?: Profile): Static<typeof MemberSchema> {
    return ({
        id: x.id,
        accepted_at: x.accepted_at,
        invited_at: x.invited_at ?? 0,
        invited_by: toUserInfo(invitedBy),
        user: toUserInfo(user),
        org: {
            title: org.title ?? "",
            id: org.id
        },
        rejected_at: x.rejected_at,
        role: x.role === "admin" ? "admin" : "member",
    });
}

export function toLocation(loc: LocationItem): schemas.Location {
    return {
        id: loc.sk,
        org_id: loc.pk,
        created_at: loc.created_at ?? 0,
        title: loc.title ?? "Untitled Location",
        updated_at: loc.updated_at ?? 0,
        image_url: loc.image?.id,
        image: loc.image !== undefined
            ? {
                id: loc.image.id,
                version: loc.image.version
            }
            : undefined,
        archived: loc.deleted,
        address: loc.address,
        email: loc.email,
        goal: loc.goal,
        phone: loc.phone
    }
}

export function toUserInfo(u?: Profile) {
    if (u !== undefined) {
        if (u.attributes !== undefined) {
            let {email, first_name, last_name, profile_pic} = u.attributes ?? {}
            if (email === undefined && u.id.includes("@")) {
                email = u.id
            }
            return {
                id: u.id,
                email,
                first_name,
                last_name,
                profile_pic
            }
        } else {
            return {id: u.id}
        }
    } else {
        return undefined
    }
}
