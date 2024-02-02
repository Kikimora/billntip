import {AuthModuleContext, AuthModuleContextSchema} from "./ctx";
import * as cookie from "cookie";

export interface SessionCookie {
    readonly id: string;
    readonly expiration?: Date;

    makeHeaderValue(): string;
}

export type SessionCookieModule = {
    load: (cookieHeader: string) => SessionCookie | null,
    create: (id: string, expiration?: Date) => SessionCookie,
    ctx: AuthModuleContext
}

export default function (ctx: AuthModuleContext) : SessionCookieModule {
    class SessionCookieImpl implements SessionCookie {

        constructor(readonly id: string, readonly expiration?: Date) {
        }

        makeHeaderValue() {
            return cookie.serialize(ctx.cookieName, this.id, {
                expires: this.expiration,
                secure: true,
                httpOnly: true,
                path: "/",
                sameSite: "strict",
            })
        }

        public static load(cookieHeader: string): SessionCookie | null {
            const cookies = cookie.parse(cookieHeader)
            const sessionId = cookies?.[ctx.cookieName]
            if (sessionId == null) return null
            return new SessionCookieImpl(sessionId)
        }
    }

    return {
        load: SessionCookieImpl.load,
        create: function (id: string, expiration?: Date) {
            return new SessionCookieImpl(id, expiration)
        },
        ctx
    } as const
}