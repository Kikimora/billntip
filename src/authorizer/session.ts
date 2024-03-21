import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {z} from "zod";
import shortUUID from "short-uuid"
import {Env, useVariables, AuthTracer} from "./ctx";
import OidcTokens from "./oidc_tokens";
import SessionCookie from "./cookie";
import {D, deleteCommand, getCommand, LockHandle, makeLockStore, putCommand, table, updateCommand} from "@app/dynamodb";
import {jwtDecode} from "jwt-decode";

const dynamoDb = new DynamoDB({region: Env.region})
const tracer = AuthTracer.withScope("session")

const shortUUIDGenerator = shortUUID(shortUUID.constants.flickrBase58)
const store = makeLockStore(Env.locksTable, {dynamoDb})

export type SessionContext = {
    access_token: object,
    id_token: object,
    expires_at: number
}

export const Sessions = table(Env.sessionTable,
    {session_id: D.String} as const,
    {
        access_token: D.String,
        id_token: D.String,
        refresh_token: D.String,
        expires_at: D.Number,
        refresh_token_expires_at: D.Number,
        cached_till: D.Number
    } as const)

/**
 * Session data stored in the session store.
 */
export default class SessionData implements SessionItem {
    /**
     * Session identifier.
     */
    readonly sessionId: string
    /**
     * Access token (sometimes JWT, sometimes opaque string) to authorize operations against backend.
     */
    readonly accessToken: string
    /**
     * JWT token with user profile information.
     */
    readonly idToken: string
    /**
     * OIDC refresh token.
     */
    readonly refreshToken: string
    /**
     * Access token expiration time as **seconds** since the [epoch]{@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date#the_epoch_timestamps_and_invalid_date}.
     * Calculated at tokens arrival as "{@link now} + {@link OidcTokens.expiresIn}".
     */
    readonly accessExpiresAt: number
    /**
     * Refresh token expiration time as **seconds** since the [epoch]{@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date#the_epoch_timestamps_and_invalid_date}.
     */
    readonly refreshTokenExpiresAt: number

    /**
     * Authorizer cache expiration as milliseconds since the [epoch]{@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date#the_epoch_timestamps_and_invalid_date}.
     * 0 indicates item was never cached.
     */
    get cachedTill() {
        return this._cachedTill
    }

    private _cachedTill: number = 0;

    /**
     * Return public information about the session
     */
    get info() {
        return {
            sessionId: this.sessionId,
            accessExpiresAt: new Date(this.accessExpiresAt * 1000),
            refreshTokenExpiresAt: new Date(this.refreshTokenExpiresAt * 1000),
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
        this.refreshTokenExpiresAt = item.refreshTokenExpiresAt
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
                refreshTokenExpiresAt: Number(attrs['refresh_token_expires_at'].N),
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
    public static createWithTokens(tokens: OidcTokens): SessionData {
        const {now, refreshTokenTtl} = useVariables()
        const refreshToken = tokens.refreshToken
        if (refreshToken == null) throw new Error('Cannot create new session without a refresh token.')
        //TODO add user sub and email to DynamoDB.
        const item = parseSessionItem({
            sessionId: makeSessionId(),
            accessToken: tokens.accessToken,
            idToken: tokens.idToken,
            refreshToken,
            accessExpiresAt: now + tokens.expiresIn,
            refreshTokenExpiresAt: now + refreshTokenTtl,
            cachedTill: 0
        });
        return new SessionData(item, false)
    }

    /**
     * Create a new version of the session data with new tokens. New session has different session id, thus session
     * cookie must be rotated.
     */
    withTokens(tokens: OidcTokens): SessionData {
        const {now, refreshTokenTtl} = useVariables()
        const isRefreshTokenRotated = tokens.refreshToken != null && tokens.refreshToken != this.refreshToken
        const item = parseSessionItem({
            sessionId: makeSessionId(),
            accessToken: tokens.accessToken,
            idToken: tokens.idToken,
            refreshToken: isRefreshTokenRotated ? tokens.refreshToken : this.refreshToken,
            accessExpiresAt: now + tokens.expiresIn,
            refreshTokenExpiresAt: isRefreshTokenRotated ? now + refreshTokenTtl : this.refreshTokenExpiresAt,
            cachedTill: this.cachedTill
        })
        return new SessionData(item, isRefreshTokenRotated, this.lock)
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
                refresh_token_expires_at: this.refreshTokenExpiresAt,
                cached_till: this.cachedTill,
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
        const {sessionId} = this
        const command = updateCommand(Sessions, {
            key: {session_id: sessionId},
            expression: ({attr, val}) => `SET
                ${attr.refresh_token} = ${val(this.refreshToken)},
                ${attr.refresh_token_expires_at} = ${val(this.refreshTokenExpiresAt)},
                ${attr.access_token} = ${val(this.accessToken)},
                ${attr.id_token} = ${val(this.idToken)},
                ${attr.expires_at} = ${val(this.accessExpiresAt)},
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
     * Notify session about a cache extension. Call this method from authorizer function to let session know that cache record TTL extended.
     */
    updateCacheTtl() {
        const {now} = useVariables()
        const {authorizerCacheTtl} = Env
        this._cachedTill = now + authorizerCacheTtl
    }

    /**
     * True if tokens are about to expire or can expire while being cached.
     */
    get isTimeToRefresh(): boolean {
        const {now} = useVariables()
        return this.cachedTill >= this.accessExpiresAt || this.accessExpiresAt - now < 10
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
        const expiration = new Date(this.refreshTokenExpiresAt * 1000)
        return new SessionCookie(this.sessionId, expiration)
    }

    /**
     * Make authentication context variables.
     */
    context() : SessionContext {
        return {
            'access_token': jwtDecode(this.accessToken),
            'id_token': jwtDecode(this.idToken),
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
    refreshTokenExpiresAt: z.number().min(1).readonly(),
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

const makeSessionId = (): string => {
    return shortUUIDGenerator.generate()
}