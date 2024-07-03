import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {Static, Type as T} from "@sinclair/typebox";
import {TypeCompiler} from "@sinclair/typebox/compiler";
import shortUUID from "short-uuid"
import {jwtDecode} from "jwt-decode";
import * as ddb from "@app/dynamodb";
import {SessionCookieRepo} from "./cookie";
import {OidcTokens} from "./oidc_tokens";
import {OperationContext, SessionContext} from "./types";
import {errorWithContext} from "@app/diagnostics";

const dynamoDb = new DynamoDB()
const shortUUIDGenerator = shortUUID(shortUUID.constants.flickrBase58)
const SessionKey = {session_id: ddb.Type.String} as const;
const SessionAttributes = {
    access_token: ddb.Type.String,
    id_token: ddb.Type.String,
    refresh_token: ddb.Type.String,
    expires_at: ddb.Type.Number,
    refresh_token_expires_at: ddb.Type.Number,
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
    store: ddb.LockStore;
    Sessions: SessionsTable

    constructor(private readonly options: SessionOptions) {
        const {locksTable, sessionTable, ctx} = options
        this.store = ddb.makeLockStore(locksTable, {dynamoDb})
        this.Sessions = ddb.table(sessionTable, SessionKey, SessionAttributes)
    }

    /**
     * Load a session record while placing a lock on it. Use {@link SessionData#release} or
     * {@link SessionData#remove} to release the lock.
     */
    public async fetchLocked(sessionId: string) {
        const {store, options:{ctx}} = this

        async function lock() {
            try {
                return await store.lock(sessionId, ctx.requestId, {retries: 5, leaseDuration: 1000, autoBump: true})
            } catch (e: any) {
                throw errorWithContext(e, "fetchLocked", {sessionId})
            }
        }

        return this._fetch(sessionId, await lock())
    }

    public async fetch(sessionId: string) {
        return this._fetch(sessionId)
    }

    /**
     * Create new session from OIDC tokens. {@param tokens} must have {@link OidcTokens#refreshToken}.
     */
    public createWithTokens(tokens: OidcTokens): SessionData {
        const {Sessions, options} = this
        const refreshToken = tokens.refreshToken
        if (refreshToken == null) throw new Error('Cannot create new session without a refresh token.')
        //TODO add user sub and email to DynamoDB.
        const item = parseSessionItem({
            sessionId: makeSessionId(),
            accessToken: tokens.accessToken,
            idToken: tokens.idToken,
            refreshToken,
            accessExpiresAt: options.ctx.now + tokens.expiresIn,
            refreshTokenExpiresAt: options.ctx.now + tokens.refreshTokenExpiresIn,
            //0 means the session is not in the cache
            cachedTill: 0
        });
        return new SessionData(item, false, Sessions, options)
    }

    private async _fetch(sessionId: string, sessionLock?: ddb.LockHandle) {
        const {Sessions, options} = this
        try {
            const command = ddb.getCommand(Sessions, {key: {session_id: sessionId}});
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
            return new SessionData(item, false, Sessions, options, sessionLock)
        } catch (e: any) {
            throw errorWithContext(e, "fetch", {sessionId})
        }
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
        this.accessToken = item.accessToken
        this.idToken = item.idToken
        this.refreshToken = item.refreshToken
        this.accessExpiresAt = item.accessExpiresAt
        this.refreshTokenExpiresAt = item.refreshTokenExpiresAt
        this._cachedTill = item.cachedTill
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
     * Create a new version of the session data with new tokens. New session has different session id, thus session
     * cookie must be rotated.
     */
    withTokens(tokens: OidcTokens): SessionData {
        const {Sessions, options: {ctx: {now, refreshTokenTtl}}} = this
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
        return new SessionData(item, isRefreshTokenRotated, Sessions, this.options, this.lock)
    }

    /**
     * Create new session in the data store.
     */
    async create() {
        const {Sessions} = this
        const command = ddb.putCommand(Sessions, {
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
            throw errorWithContext(e, "create", {command: command.input})
        }
    }

    /**
     * Save session data to the store.
     */
    async save() {
        const {sessionId, Sessions} = this
        const command = ddb.updateCommand(Sessions, {
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
            throw errorWithContext(e, "save", {sessionId})
        }
    }

    /**
     * Notify session about a cache extension. Call this method from authorizer function to let session know that cache record TTL extended.
     */
    updateCacheTtl() {
        const {now, authorizerCacheTtl} = this.options.ctx
        this._cachedTill = now + authorizerCacheTtl
    }

    /**
     * True if tokens expired, about to expire or can expire while being cached.
     */
    get isTimeToRefresh(): boolean {
        const {now} = this.options.ctx
        return this.cachedTill >= this.accessExpiresAt || this.accessExpiresAt - now < 10
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
     * Create cookie for the session data
     */
    makeCookie() {
        const expiration = new Date(this.refreshTokenExpiresAt * 1000)
        return this.options.cookies.create(this.sessionId, expiration)
    }

    /**
     * Make authentication context variables.
     */
    context(): SessionContext {
        return {
            'id': this.sessionId,
            'access': jwtDecode(this.accessToken),
            'access_token': this.accessToken,
            'profile': jwtDecode(this.idToken),
            'id_token': this.idToken,
            'expires_at': this.accessExpiresAt
        }
    }
}

const SessionItemSchema = T.Object({
    sessionId: T.String(),
    accessToken: T.String(),
    idToken: T.String(),
    refreshToken: T.String(),
    accessExpiresAt: T.Number({minimum: 1}),
    refreshTokenExpiresAt: T.Number({minimum: 1}),
    cachedTill: T.Number({minimum: 0}),
})

type SessionItem = Static<typeof SessionItemSchema>
const SessionItemChecker = TypeCompiler.Compile(SessionItemSchema)

function parseSessionItem(x: Partial<SessionItem>): SessionItem {
    try {
        return SessionItemChecker.Decode(x)
    } catch (e) {
        throw errorWithContext(e, "parse", {sessionItem: x})
    }
}

const makeSessionId = (): string => {
    return shortUUIDGenerator.generate()
}