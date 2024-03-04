import {Env, useVariables} from "./ctx";
import {v4 as uuidv4} from "uuid";
import {ConditionalCheckFailedException, DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {retry} from "../util";
import OidcTokens from "./oidc_tokens";
import {z} from "zod";
import crypto from "crypto";
import SessionCookie from "./cookie";
import {D, deleteCommand, putCommand, table, updateCommand} from "../dynamodb";
import {errorContext, withErrorContext} from "../diagnostics";

const dynamoDb = new DynamoDBClient({region: Env.region})

export const Sessions = table(Env.sessionTable,
    {session_id: D.String} as const,
    {
        access_token: D.String,
        id_token: D.String,
        refresh_token: D.String,
        expires_at: D.Number,
        session_expires_at: D.Number,
        salt: D.String,
        lock: D.String,
        lock_till: D.Number,
    } as const)

/**
 * Session data stored in the session store.
 */
export default class SessionData implements SessionItem {
    readonly sessionId: string
    readonly accessToken: string
    readonly idToken: string
    readonly refreshToken: string
    readonly accessExpiresAt: number
    readonly sessionExpiresAt: number
    readonly salt: string

    /**
     * @param item session item loaded from the store
     * @param isRefreshTokenRotated True if this session was created from another session with different refresh token.
     * @param lockId lock identifier
     */
    private constructor(item: SessionItem,
                        readonly isRefreshTokenRotated: boolean,
                        readonly lockId?: string) {
        this.sessionId = item.sessionId
        this.accessToken = item.accessToken
        this.idToken = item.idToken
        this.refreshToken = item.refreshToken
        this.accessExpiresAt = item.accessExpiresAt
        this.sessionExpiresAt = item.sessionExpiresAt
        this.salt = item.salt
    }

    /**
     * Load a session record while placing a lock on it. Use {@link SessionData#release} or
     * {@link SessionData#remove} to release the lock.
     */
    public static async loadAndLock(sessionId: string) {
        const lockId = uuidv4()
        const {now} = useVariables()
        const lockTill = now + 10 //lock for 10 seconds
        const loadSessionData = async () => {

            const command = updateCommand(Sessions, {
                key: {session_id: sessionId},
                values: {now},
                expression: ({attr, val}) => `SET
                        ${attr.lock_till} = ${val(lockTill)},
                        ${attr.lock} = ${val(lockId)}
                    `,
                condition: ({key: {session_id}, attr: {lock, lock_till}, val: {now}}) =>
                    `attribute_exists(${session_id}) AND (attribute_not_exists(${lock}) OR (${lock_till} <= ${now}))`,
                returnOnConditionFailure: "ALL_OLD",
                return: "ALL_NEW"
            });
            try {
                const {Attributes: attrs} = await dynamoDb.send(command)
                if (attrs == null) return null
                const item = parseSessionItem({
                    sessionId,
                    accessToken: attrs['access_token'].S,
                    idToken: attrs['id_token'].S,
                    refreshToken: attrs['refresh_token'].S,
                    accessExpiresAt: Number(attrs['expires_at'].N),
                    sessionExpiresAt: Number(attrs['session_expires_at'].N),
                    salt: attrs['salt'].S,
                });
                return new SessionData(item, false, lockId)
            } catch (e: any) {
                if (e instanceof ConditionalCheckFailedException && e.Item == null)
                    return null
                throw withErrorContext(e, "loadSessionData", {command: command.input})
            }
        };

        return await retry(loadSessionData, {maxIterations: 5, timeout: 2500, delay: 300})
    }

    /**
     * Release session data lock. This should be the last method to call on a session data instance.
     */
    async release() {
        if (this.lockId == null) return

        const {now} = useVariables()

        const command = updateCommand(Sessions, {
            return: "ALL_NEW",
            returnOnConditionFailure: "ALL_OLD",
            key: {session_id: this.sessionId},
            values: {now, lock: this.lockId},
            expression: ({attr}) => `REMOVE ${attr.lock}`,
            condition: ({key, attr, val}) =>
                `attribute_exists(${key.session_id}) AND (${attr.lock} = ${val.lock}) AND (${attr.lock_till} >= ${val.now})`,
        });
        try {
            await dynamoDb.send(command)
        } catch (e) {
            if (e instanceof ConditionalCheckFailedException) {
                return
            }
            throw withErrorContext(e, "release", {command: command.input})
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
            accessExpiresAt: now + tokens.expiresIn,
            sessionExpiresAt: now + refreshTokenTtl,
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
            salt: this.salt
        })
        return new SessionData(item, isNew, this.lockId)
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
                salt: this.salt
            },
            condition: ({key: {session_id}}) => `attribute_not_exists(${session_id})`
        });
        try {
            await dynamoDb.send(command)
        } catch (e) {
            throw withErrorContext(e, "create", {command: command.input})
        }
    }

    /**
     * Save session data to the store.
     */
    async save() {
        const {now} = useVariables()
        const command = updateCommand(Sessions, {
            key: {session_id: this.sessionId},
            values: {now, lock: this.lockId},
            expression: ({attr, val}) => `SET
                ${attr.refresh_token} = ${val(this.refreshToken)},
                ${attr.expires_at} = ${val(this.accessExpiresAt)},
                ${attr.session_expires_at} = ${val(this.sessionExpiresAt)},
                ${attr.access_token} = ${val(this.accessToken)},
                ${attr.id_token} = ${val(this.idToken)},
                ${attr.salt} = ${val(this.salt)}
            `,
            condition: ({key, attr, val}) =>
                `attribute_exists(${key.session_id}) AND (${attr.lock} = ${val.lock}) AND (${attr.lock_till} >= ${val.now})`,
        });
        try {
            await dynamoDb.send(command)
        } catch (e) {
            errorContext(e, "save", {command: command.input})
            throw e
        }
    }

    /**
     * True if it is time to refresh access token.
     */
    get isTimeToRefresh(): boolean {
        const {now, accessTokenTtl} = useVariables()
        return now >= (this.accessExpiresAt - accessTokenTtl - 60)
    }

    /**
     * Remove session data from the store
     */
    async remove() {
        const command = deleteCommand(Sessions, {
            key: {session_id: this.sessionId},
        });
        try {
            await dynamoDb.send(command)
        } catch (e) {
            errorContext(e, "remove", {command: command.input})
            throw e
        }
    }

    /**
     * Create cookie for the session data
     */
    makeCookie() {
        const {now, refreshTokenTtl} = useVariables()
        const newSessionExpiresAt = now + refreshTokenTtl
        const expiration = new Date(newSessionExpiresAt * 1000)
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
})
type SessionItem = z.infer<typeof SessionItemSchema>

function parseSessionItem(x: Partial<SessionItem>): SessionItem {
    try {
        return SessionItemSchema.parse(x)
    } catch (e) {
        throw withErrorContext(e, "parseSessionItem", {sessionItem: x})
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