import * as cookie from "cookie";
import {OperationContext} from "./types";

export class SessionCookieRepo {
    constructor(private readonly ctx: OperationContext) {
    }

    public load(cookieHeader: string): SessionCookie | null {
        const cookies = cookie.parse(cookieHeader)
        const {cookieName} = this.ctx
        const sessionId = cookies?.[cookieName]
        if (sessionId == null) return null
        return new SessionCookie(sessionId, this.ctx)
    }

    public create(id: string, expiration?: Date) {
        return new SessionCookie(id, this.ctx, expiration)
    }
}

export class SessionCookie {

    constructor(readonly id: string, private readonly ctx: OperationContext, public readonly expiration?: Date) {
    }

    makeHeaderValue() {
        const {cookieName, sameSite} = this.ctx

        return cookie.serialize(cookieName, this.id, {
            expires: this.expiration,
            secure: true,
            httpOnly: true,
            path: "/",
            sameSite: sameSite,
            partitioned: sameSite == "none"
        })
    }
}