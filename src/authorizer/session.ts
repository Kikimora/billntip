import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {z} from "zod";
import crypto from "crypto";
import {Env, useVariables, AuthTracer} from "./ctx";
import OidcTokens from "./oidc_tokens";
import SessionCookie from "./cookie";
import {D, deleteCommand, getCommand, LockHandle, makeLockStore, putCommand, table, updateCommand} from "@app/dynamodb";

const dynamoDb = new DynamoDB({region: Env.region})
const tracer = AuthTracer.withScope("session")
//TODO create table in infra and pass it name in env variable.
const store = makeLockStore(Env.locksTable, {dynamoDb})

export const Sessions = table(Env.sessionTable,
    {session_id: D.String} as const,
    {
        access_token: D.String,
        id_token: D.String,
        refresh_token: D.String,
        expires_at: D.Number,
        session_expires_at: D.Number,
        cached_till: D.Number,
        salt: D.String
    } as const)

/**
 * Session data stored in the session store.
 */
export default class SessionData implements SessionItem {
    readonly sessionId: string
    readonly accessToken: string
    readonly idToken: string
    readonly refreshToken: string
    /**
     * Access token expiration time unix epoch (seconds from 1 January 1970).
     * Calculated at tokens arrival as `now + tokens.expiresIn`.
     */
    readonly accessExpiresAt: number
    /**
     * Refresh token expiration time as unix epoch (seconds from 1 January 1970),
     */
    readonly sessionExpiresAt: number

    /**
     * Authorizer cache expiration as unix epoch (seconds from 1 January 1970).
     * 0 indicates item was never cached.
     */
    get cachedTill() {
        return this._cachedTill
    }

    private _cachedTill: number = 0;
    readonly salt: string

    /**
     * Return public infomration about the session
     */
    get info() {
        return {
            sessionId: this.sessionId,
            accessExpiresAt: new Date(this.accessExpiresAt * 1000),
            sessionExpiresAt: new Date(this.sessionExpiresAt * 1000),
            cachedTill: this.cachedTill
        }
    }

    /**
     * @param item session item loaded from the store
     * @param isRefreshTokenRotated True if this session was created from another session with different refresh token.
     * @param lock lock handle, when present indicate the session data is locked.
     */
    constructor(item: SessionItem,
                readonly isRefreshTokenRotated: boolean,
                readonly lock?: LockHandle) {
        this.sessionId = item.sessionId
        this.accessToken = item.accessToken
        this.idToken = item.idToken
        this.refreshToken = item.refreshToken
        this.accessExpiresAt = item.accessExpiresAt
        this.sessionExpiresAt = item.sessionExpiresAt
        this.salt = item.salt
        this._cachedTill = item.cachedTill
    }

    /**
     * Load a session record while placing a lock on it. Use {@link SessionData#release} or
     * {@link SessionData#remove} to release the lock.
     */
    public static async loadAndLock(sessionId: string) {
        try {
            const {requestId} = useVariables()
            const sessionLock = await store.lock(sessionId, requestId, {retries: 5, heartbeatInterval: 100})
            const command = getCommand(Sessions, {key: {session_id: sessionId}});
            const {Item: attrs} = await dynamoDb.send(command)
            if (attrs == null) return null
            const item = parseSessionItem({
                sessionId,
                accessToken: attrs['access_token'].S,
                idToken: attrs['id_token'].S,
                refreshToken: attrs['refresh_token'].S,
                accessExpiresAt: Number(attrs['expires_at'].N),
                sessionExpiresAt: Number(attrs['session_expires_at'].N),
                salt: attrs['salt'].S,
                cachedTill: Number(attrs['cached_till'].N),
            });
            return new SessionData(item, false, sessionLock)
        } catch (e) {
            throw tracer.addContext(e, {sessionId})
        }
    }

    /**
     * Release session data lock. This should be the last method to call on a session data instance.
     */
    async release() {
        const {sessionId, lock} = this
        if (lock == null) return
        try {
            await lock.unlock()
        } catch (e) {
            throw tracer.addContext(e, {sessionId, lock})
        }
    }

    /**
     * Create new session from OIDC tokens. {@param tokens} must have {@link OidcTokens#refreshToken}.
     */
    public static fromTokens(tokens: OidcTokens): SessionData {
        const salt = generateSalt(16)
        const {now, refreshTokenTtl} = useVariables()
        const refreshToken = tokens.refreshToken
        if (refreshToken == null) throw new Error('Cannot create new session without a refresh token.')
        //TODO add user sub and email to DynamoDB.
        const item = parseSessionItem({
            sessionId: makeSessionId(refreshToken, salt),
            accessToken: tokens.accessToken,
            idToken: tokens.idToken,
            refreshToken,
            accessExpiresAt: Math.floor((now + tokens.expiresIn * 1000) / 1000),
            sessionExpiresAt: Math.floor((now + refreshTokenTtl * 1000) / 1000),
            cachedTill: 0,
            salt
        });
        return new SessionData(item, false)
    }

    /**
     * Create a new version of the session data with new tokens.
     */
    withTokens(tokens: OidcTokens): SessionData {
        const {now, refreshTokenTtl} = useVariables()
        const isNew = tokens.refreshToken != null && tokens.refreshToken != this.refreshToken
        const item = parseSessionItem({
            sessionId: isNew ? makeSessionId(tokens.refreshToken, this.salt) : this.sessionId,
            accessToken: tokens.accessToken,
            idToken: tokens.idToken,
            refreshToken: isNew ? tokens.refreshToken : this.refreshToken,
            accessExpiresAt: now + tokens.expiresIn,
            sessionExpiresAt: isNew ? now + refreshTokenTtl : this.sessionExpiresAt,
            salt: this.salt,
            cachedTill: this.cachedTill
        })
        return new SessionData(item, isNew, this.lock)
    }

    /**
     * Create new session in the data store.
     */
    async create() {
        const command = putCommand(Sessions, {
            key: {session_id: this.sessionId},
            item: {
                refresh_token: this.refreshToken,
                access_token: this.accessToken,
                id_token: this.idToken,
                expires_at: this.accessExpiresAt,
                session_expires_at: this.sessionExpiresAt,
                cached_till: this.cachedTill,
                salt: this.salt
            },
            condition: ({key: {session_id}}) => `attribute_not_exists(${session_id})`
        });
        try {
            await dynamoDb.send(command)
        } catch (e) {
            throw tracer.addContext(e, {command: command.input})
        }
    }

    /**
     * Save session data to the store.
     */
    async save() {
        const {now} = useVariables()
        const {sessionId} = this
        const command = updateCommand(Sessions, {
            key: {session_id: sessionId},
            values: {now},
            expression: ({attr, val}) => `SET
                ${attr.refresh_token} = ${val(this.refreshToken)},
                ${attr.expires_at} = ${val(this.accessExpiresAt)},
                ${attr.session_expires_at} = ${val(this.sessionExpiresAt)},
                ${attr.access_token} = ${val(this.accessToken)},
                ${attr.id_token} = ${val(this.idToken)},
                ${attr.salt} = ${val(this.salt)},
                ${attr.cached_till} = ${val(this.cachedTill)}
            `,
            condition: ({key}) => `attribute_exists(${key.session_id})`,
        });
        try {
            await dynamoDb.send(command)
        } catch (e) {
            throw tracer.addContext(e, {sessionId})
        }
    }

    /**
     * Notify session about a cache extension. Call this method from authorizer function.
     */
    notifyCacheTtlExtension() {
        const {now} = useVariables()
        const {authorizerCacheTtl} = Env
        this._cachedTill = Math.floor(now / 1000 + authorizerCacheTtl)
    }

    /**
     * True if tokens are about to expire or can expire while being cached.
     */
    get isTimeToRefresh(): boolean {
        const {now} = useVariables()
        return this.cachedTill >= this.accessExpiresAt || this.accessExpiresAt * 1000 - now < 10000
    }

    /**
     * Remove session data from the store
     */
    async remove() {
        const {sessionId} = this
        const command = deleteCommand(Sessions, {
            key: {session_id: sessionId},
        });
        try {
            await dynamoDb.send(command)
        } catch (e) {
            throw tracer.addContext(e, {sessionId})
        }
    }

    /**
     * Create cookie for the session data
     */
    makeCookie() {
        const {now, refreshTokenTtl} = useVariables()
        const newSessionExpiresAt = now + refreshTokenTtl * 1000
        const expiration = new Date(newSessionExpiresAt)
        return new SessionCookie(this.sessionId, expiration)
    }

    /**
     * Make authentication context variables.
     */
    context() {
        return {
            'access_token': this.accessToken,
            'id_token': this.idToken,
            'expires_at': this.accessExpiresAt
        }
    }
}

const SessionItemSchema = z.object({
    sessionId: z.string().min(1).readonly(),
    accessToken: z.string().min(1).readonly(),
    idToken: z.string().min(1).readonly(),
    refreshToken: z.string().min(1).readonly(),
    accessExpiresAt: z.number().min(1).readonly(),
    sessionExpiresAt: z.number().min(1).readonly(),
    salt: z.string().min(1).readonly(),
    cachedTill: z.number().min(0).readonly(),
})
type SessionItem = z.infer<typeof SessionItemSchema>

function parseSessionItem(x: Partial<SessionItem>): SessionItem {
    try {
        return SessionItemSchema.parse(x)
    } catch (e) {
        throw tracer.addContext(e, {sessionItem: x})
    }
}

/**
 * Generate base64 encoded salt
 */
const generateSalt = (length: number): string => {
    return crypto.randomBytes(length).toString('base64');
}

/**
 * Generate session id by hashing refresh token.
 */
const makeSessionId = (refreshToken: string, salt: string): string => {
    return crypto.pbkdf2Sync(refreshToken, salt, 10000, 64, 'sha256').toString('base64url')
}