import {Env} from "./ctx";
import * as cookie from "cookie";

export default class SessionCookie {

    constructor(readonly id: string, readonly expiration?: Date) {
    }

    makeHeaderValue() {
        return cookie.serialize(Env.cookieName, this.id, {
            expires: this.expiration,
            secure: true,
            httpOnly: true,
            path: "/",
            sameSite: "strict",
        })
    }

    public static create(...args: ConstructorParameters<typeof SessionCookie>) {
        return new SessionCookie(...args)
    }

    public static load(cookieHeader: string): SessionCookie | null {
        const cookies = cookie.parse(cookieHeader)
        const sessionId = cookies?.[Env.cookieName]
        if (sessionId == null) return null
        return new SessionCookie(sessionId)
    }
}