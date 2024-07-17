import {DynamoDB} from "@aws-sdk/client-dynamodb";
import shortUUID from "short-uuid"
import {jwtDecode} from "jwt-decode";
import * as ddb from "@app/dynamodb";
import {SessionCookie, SessionCookieRepo} from "./cookie";
import {OidcTokens} from "./oidc_tokens";
import {OperationContext, SessionContext} from "./types";
import {errorWithContext} from "@app/diagnostics";
import _ from "lodash";

const dynamoDb = new DynamoDB()
const sessionIdGenerator = shortUUID(shortUUID.constants.flickrBase58)
const suffixGenerator = shortUUID(shortUUID.constants.flickrBase58, {consistentLength: false})
const SessionKey = {session_id: ddb.Type.String} as const;
const SessionAttributes = {
    user_id: ddb.Type.String,
    updated_at: ddb.Type.Number,
    access_token: ddb.Type.String,
    id_token: ddb.Type.String,
    refresh_token: ddb.Type.String,
    access_token_expires_at: ddb.Type.Number,
    refresh_token_expires_at: ddb.Type.Number,
    session_expires_at: ddb.Type.Number,
    cached_till: ddb.Type.Number
} as const;

type SessionsTable = ddb.TableSchema<typeof SessionKey, typeof SessionAttributes>

interface SessionOptions {
    locksTable: string
    sessionTable: string
    ctx: OperationContext
    cookies: SessionCookieRepo
}

export class SessionRepo {
    readonly locks: ddb.LockStore;
    readonly Sessions: SessionsTable

    constructor(private readonly options: SessionOptions) {
        const {locksTable, sessionTable} = options
        this.locks = ddb.makeLockStore(locksTable, {dynamoDb})
        this.Sessions = ddb.table(sessionTable, SessionKey, SessionAttributes)
    }

    /**
     * Load a session record while placing a lock on it. Use {@link SessionData#release} or
     * {@link SessionData#remove} to release the lock.
     */
    public async fetchLocked(sessionId: SessionCookie | string) {
        const {locks, options: {ctx}} = this
        if (sessionId instanceof SessionCookie)
            sessionId = this.sessionId(sessionId)

        async function lock(sessionId: string) {
            try {
                return await locks.lock(sessionId, ctx.requestId, {retries: 5, leaseDuration: 1000, autoBump: true})
            } catch (e: any) {
                throw errorWithContext(e, "fetchLocked", {sessionId})
            }
        }

        const sessionLock = await lock(sessionId);

        async function unlock() {
            try {
                await sessionLock.unlock()
            } catch (e: any) {
                throw errorWithContext(e, "fetch", {cause: e})
            }
        }

        let session: SessionData | null;
        try {
            session = await this._fetch(sessionId, sessionLock)
        } catch (e: any) {
            await unlock()
            throw e
        }
        if (session == null) {
            await unlock()
        }

        return session
    }

    /**
     * Load session based on session id or session cookie.
     */
    public async fetch(sessionId: SessionCookie | string) {
        if (sessionId instanceof SessionCookie)
            sessionId = this.sessionId(sessionId)
        return this._fetch(sessionId)
    }

    /**
     * Create new session from OIDC tokens. {@param tokens} must have {@link OidcTokens#refreshToken}.
     */
    public async createWithTokens(tokens: OidcTokens): Promise<SessionData> {
        const {Sessions, options} = this
        const refreshToken = tokens.refreshToken
        if (refreshToken == null) throw new Error('Cannot create new session without a refresh token.')
        const idToken = tokens.idTokenPayload ?? await tokens.verifyIdToken()
        const sessionTokenId = idToken.origin_jti
        const sessionId = sessionIdGenerator.fromUUID(sessionTokenId)

        const item: SessionItem = {
            sessionId,
            updatedAt: Date.now(),
            userId: idToken.sub ?? "",
            accessToken: tokens.accessToken,
            idToken: tokens.idToken,
            refreshToken,
            accessExpiresAt: options.ctx.now + tokens.expiresIn,
            refreshTokenExpiresAt: options.ctx.now + tokens.refreshTokenExpiresIn,
            sessionExpiresAt: options.ctx.now + options.ctx.sessionInactivityTimeout,
            //0 means the session is not in the cache
            cachedTill: 0
        }
        return new SessionData(item, false, Sessions, options)
    }

    private async _fetch(sessionId: string, sessionLock?: ddb.LockHandle) {
        const {Sessions, options} = this
        try {
            const command = ddb.getCommand(Sessions, {key: {session_id: sessionId}});
            const {Item: attrs} = await dynamoDb.send(command)
            if (attrs == null) return null

            const accessToken = attrs['access_token'].S;
            const idToken = attrs['id_token'].S;
            const userId = attrs['user_id']?.S;
            const refreshToken = attrs['refresh_token'].S;

            if (accessToken === undefined) return null
            if (idToken === undefined) return null
            if (userId === undefined) return null
            if (refreshToken === undefined) return null

            const item = {
                sessionId,
                updatedAt: Number(attrs['updated_at'].N ?? 0),
                userId,
                accessToken,
                idToken,
                refreshToken,
                accessExpiresAt: Number(attrs['access_token_expires_at'].N ?? 0),
                refreshTokenExpiresAt: Number(attrs['refresh_token_expires_at'].N ?? 0),
                sessionExpiresAt: Number(attrs['session_expires_at']?.N ?? 0),
                cachedTill: Number(attrs['cached_till'].N ?? 0),
            }

            return new SessionData(item, false, Sessions, options, sessionLock)
        } catch (e: any) {
            throw errorWithContext(e, "fetch", {sessionId, sessionLock})
        }
    }

    /**
     * Get session id from a session cookie value.
     */
    sessionId(cookie: SessionCookie) {
        const [sessionId] = cookie.value.split('.')
        return sessionId
    }
}

/**
 * Session data stored in the session store.
 */
export class SessionData implements SessionItem {
    /**
     * Session identifier.
     */
    readonly sessionId: string
    /**
     * The most recent session update timestamp.
     */
    readonly updatedAt: number
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
     * Session cookie token expiration time as **seconds** since the [epoch]{@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date#the_epoch_timestamps_and_invalid_date}.
     */
    readonly sessionExpiresAt: number
    /**
     * Session user id
     */
    readonly userId: string

    /**
     * Authorizer cache expiration as milliseconds since the [epoch]{@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date#the_epoch_timestamps_and_invalid_date}.
     * 0 indicates item was never cached.
     */
    readonly cachedTill: number

    private readonly _updates: Partial<SessionItem> = {}

    /**
     * Return public information about the session
     */
    get info() {
        return {
            sessionId: this.sessionId,
            updatedAt: this.updatedAt,
            userId: this.userId,
            sessionExpiresAt: this.sessionExpiresAt,
            accessExpiresAt: this.accessExpiresAt,
            refreshTokenExpiresAt: this.refreshTokenExpiresAt,
            cachedTill: this.cachedTill,
        }
    }

    /**
     * @param item session item loaded from the store
     * @param isRefreshTokenRotated True if this session was created from another session with different refresh token.
     * @param Sessions session table
     * @param options session options
     * @param lock lock handle, when present indicate the session data is locked.
     */
    constructor(item: SessionItem,
                readonly isRefreshTokenRotated: boolean,
                readonly Sessions: SessionsTable,
                readonly options: SessionOptions,
                readonly lock?: ddb.LockHandle) {
        this.sessionId = item.sessionId
        this.updatedAt = item.updatedAt
        this.userId = item.userId
        this.accessToken = item.accessToken
        this.idToken = item.idToken
        this.refreshToken = item.refreshToken
        this.sessionExpiresAt = item.sessionExpiresAt
        this.accessExpiresAt = item.accessExpiresAt
        this.refreshTokenExpiresAt = item.refreshTokenExpiresAt
        this.cachedTill = item.cachedTill
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
            throw errorWithContext(e, "release", {sessionId, lock})
        }
    }

    /**
     * Create a new version of the session data with new tokens.
     */
    updateTokens(tokens: OidcTokens) {
        const {options: {ctx: {now, refreshTokenTtl}}} = this
        const isRefreshTokenRotated = tokens.refreshToken != null && tokens.refreshToken != this.refreshToken
        return this.update({
            accessToken: tokens.accessToken,
            idToken: tokens.idToken,
            accessExpiresAt: now + tokens.expiresIn,
            refreshToken: isRefreshTokenRotated ? tokens.refreshToken : this.refreshToken,
            refreshTokenExpiresAt: isRefreshTokenRotated ? now + refreshTokenTtl : this.refreshTokenExpiresAt
        })
    }

    /**
     * Bump session cached till and expiration timestamps.
     */
    bump() {
        const {options: {ctx: {now, authorizerCacheTtl, sessionInactivityTimeout}}} = this
        const cachedTill = now + authorizerCacheTtl
        const sessionExpiresAt = now + sessionInactivityTimeout
        return this.update({
            cachedTill,
            sessionExpiresAt
        })
    }

    makeSessionItem(): SessionItem {
        return {
            sessionId: this.sessionId,
            updatedAt: this.updatedAt,
            userId: this.userId,
            accessToken: this.accessToken,
            idToken: this.idToken,
            refreshToken: this.refreshToken,
            accessExpiresAt: this.accessExpiresAt,
            refreshTokenExpiresAt: this.refreshTokenExpiresAt,
            sessionExpiresAt: this.sessionExpiresAt,
            cachedTill: this.cachedTill,
        }
    }

    /**
     * Create new sessions with updated data.
     */
    update(update: Partial<SessionItem>) {
        _.merge(this._updates, update)
        return this
    }

    /**
     * Create new session with pending updates.
     */
    applyUpdates() {
        const {isRefreshTokenRotated, Sessions, options} = this
        const item: SessionItem = {...this.makeSessionItem(), ...this._updates, updatedAt: Date.now()};
        return new SessionData(item, isRefreshTokenRotated, Sessions, options)
    }

    /**
     * Save session data to the store.
     */
    async save() {
        const {Sessions} = this
        const command = ddb.putCommand(Sessions, {
            key: {session_id: this.sessionId},
            item: {
                updated_at: Date.now(),
                user_id: this.userId,
                session_expires_at: this.sessionExpiresAt,
                refresh_token: this.refreshToken,
                access_token: this.accessToken,
                id_token: this.idToken,
                access_token_expires_at: this.accessExpiresAt,
                refresh_token_expires_at: this.refreshTokenExpiresAt,
                cached_till: this.cachedTill,
            }
        });
        try {
            await dynamoDb.send(command)
        } catch (e) {
            throw errorWithContext(e, "create", {command: command.input})
        }
        return this
    }

    /**
     * True if tokens expired, about to expire or can expire while being cached.
     */
    get isTimeToRefreshTokens(): boolean {
        const {now} = this.options.ctx
        return this.cachedTill >= this.accessExpiresAt || this.accessExpiresAt - now < 10
    }

    /**
     * True if session has expired.
     */
    get isSessionExpired(): boolean {
        const {sessionExpiresAt, refreshTokenExpiresAt, options: {ctx: {now}}} = this
        return now >= sessionExpiresAt || now >= refreshTokenExpiresAt
    }

    /**
     * Remove session data from the store
     */
    async remove() {
        const {sessionId, Sessions} = this
        const command = ddb.deleteCommand(Sessions, {
            key: {session_id: sessionId},
        });
        try {
            await dynamoDb.send(command)
        } catch (e) {
            throw errorWithContext(e, "remove", {sessionId})
        }
    }

    /**
     * Create a new unique session cookie.
     */
    newSessionCookie() {
        const expiration = new Date(this.refreshTokenExpiresAt * 1000)
        //Make session cookie unique to bypass API GW authorizer cache (which we cannot invalidate).
        const sessionSuffix = suffixGenerator.fromUUID(Date.now().toString(16))
        return this.options.cookies.create(`${this.sessionId}.${sessionSuffix}`, expiration)
    }

    /**
     * Make authentication context variables.
     */
    context(): SessionContext {
        return {
            'id': this.sessionId,
            'updated_at': this.updatedAt,
            'access_token_json': jwtDecode(this.accessToken),
            'access_token': this.accessToken,
            'id_token_json': jwtDecode(this.idToken),
            'id_token': this.idToken,
            'access_token_expires_at': this.accessExpiresAt,
            'session_expires_at': this.sessionExpiresAt
        }
    }
}

interface SessionItem {
    accessExpiresAt: number
    accessToken: string
    cachedTill: number
    idToken: string
    refreshToken: string
    refreshTokenExpiresAt: number
    sessionExpiresAt: number
    sessionId: string
    updatedAt: number
    userId: string
}