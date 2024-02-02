import {AuthModuleContext} from "./ctx";
import {v4 as uuidv4} from "uuid";
import {
    ConditionalCheckFailedException,
    DeleteItemCommand,
    DynamoDBClient,
    PutItemCommand,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import {retry} from "../util";
import {OidcTokens} from "./oidc_tokens";
import {SessionCookie} from "./cookie";
import {z} from "zod";
import crypto from "crypto";

export type SessionModule = {
    readonly loadAndLock: (sessionId: string) => Promise<SessionData | null>,
    readonly fromTokens: (tokens: OidcTokens) => SessionData
    readonly dynamoDb: DynamoDBClient
}

export interface SessionData {
    readonly sessionId: string;
    readonly accessToken: string;
    readonly idToken: string;
    readonly refreshToken: string;
    readonly accessExpiresAt: number;
    readonly sessionExpiresAt: number;
    readonly salt: string;
    readonly isRefreshTokenRotated: boolean;
    readonly lockId?: string;
    readonly isTimeToRefresh: boolean;

    /**
     * Release session data lock. This should be the last method to call on a session data instance.
     */
    release(): Promise<void>;

    /**
     * Create a new version of the session data with new tokens.
     */
    withTokens(tokens: OidcTokens): SessionData;

    /**
     * Save session data to the store. Typically called after making new session using {@link withTokens}.
     */
    save(): Promise<void>;

    /**
     * Remove session data from the store
     */
    remove(): Promise<void>;

    /**
     * Create cookie for the session data
     */
    makeCookie(): any;

    /**
     * Make authentication context variables.
     */
    context(): {
        access_token: any;
        expires_at: any;
        id_token: any
    };
}

export default function (createSessionCookie: (id: string, expiration?: Date) => SessionCookie,
                         ctx: AuthModuleContext): SessionModule {

    const dynamoDb = new DynamoDBClient({region: ctx.region})

    /**
     * Session data stored in the session store.
     */
    class SessionDataImpl implements SessionItem, SessionData {

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
        constructor(item: SessionItem,
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
         * Load a session record while placing a lock on it. Use {@link SessionDataImpl#release} or
         * {@link SessionDataImpl#remove} to release the lock.
         */
        public static async loadAndLock(sessionId: string) {
            const lockId = uuidv4()
            const lockTill = ctx.now + 3_000

            const loadSessionData = async () => {
                const lockAndReadCommand = new UpdateItemCommand({
                    TableName: ctx.sessionTable,
                    ReturnValues: "ALL_NEW",
                    Key: {"session_id": {S: sessionId}},
                    ConditionExpression: "(attribute_exists(#sessionId)) AND ((#lock = :null) OR (#lockTill <= :now))",
                    UpdateExpression: "SET #lockTill = :lockTill, #lock = :lock",
                    ExpressionAttributeNames: {
                        "#sessionId": "session_id",
                        "#lock": "lock",
                        "#lockTill": "lock_till"
                    },
                    ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                    ExpressionAttributeValues: {
                        ":null": {NULL: true},
                        ":lockTill": {N: `${lockTill}`},
                        ":lock": {S: lockId},
                        ":now": {N: `${Math.floor(Date.now() / 1000)}`}
                    }
                });
                try {
                    const {Attributes: attrs} = await dynamoDb.send(lockAndReadCommand)
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
                    return new SessionDataImpl(item, false, lockId)
                } catch (e) {
                    if (e instanceof ConditionalCheckFailedException && e.Item == null)
                        return null
                    throw e
                }
            };

            return await retry(loadSessionData, {maxIterations: 5, timeout: 2500, delay: 300})
        }

        /**
         * Release session data lock. This should be the last method to call on a session data instance.
         */
        async release() {
            if (this.lockId == null) return

            const key = {S: this.sessionId}
            const unlockCommand = new UpdateItemCommand({
                TableName: ctx.sessionTable,
                ReturnValues: "ALL_NEW",
                Key: {"session_id": key},
                UpdateExpression: "SET #lock = :null",
                ConditionExpression: "attribute_exists(#sessionId) AND #lock = :lock",
                ExpressionAttributeNames: {
                    "#lock": "lock",
                    "#sessionId": "session_id"
                },
                ExpressionAttributeValues: {
                    ":sessionId": key,
                    ":lock": {S: this.lockId}
                },
                ReturnValuesOnConditionCheckFailure: "ALL_OLD"
            })

            try {
                await dynamoDb.send(unlockCommand)
            } catch (e) {
                if (e instanceof ConditionalCheckFailedException) {
                    if (e.Item?.['session_id']?.S != null) {
                        throw e
                    }
                }
            }
        }

        /**
         * Create new session from OIDC tokens. {@param tokens} must have {@link OidcTokens#refreshToken}.
         */
        public static fromTokens(tokens: OidcTokens): SessionData {
            const salt = generateSalt(16)
            const refreshToken = tokens.refreshToken
            if (refreshToken == null) throw new Error('Cannot create new session without a refresh token.')
            const idToken = tokens.idTokenPayload ?? {}
            //TODO add user sub and email to DynamoDB.
            const item = parseSessionItem({
                sessionId: makeSessionId(refreshToken, salt),
                accessToken: tokens.accessToken,
                idToken: tokens.idToken,
                refreshToken,
                accessExpiresAt: ctx.now + tokens.expiresAtSec,
                sessionExpiresAt: ctx.now + ctx.refreshTokenTtlSec - 120,
                salt
            });
            return new SessionDataImpl(item, false)
        }

        /**
         * Create a new version of the session data with new tokens.
         */
        withTokens(tokens: OidcTokens): SessionDataImpl {
            const isNew = tokens.refreshToken != null && tokens.refreshToken != this.refreshToken
            const item = parseSessionItem({
                sessionId: isNew ? makeSessionId(tokens.refreshToken, this.salt) : this.sessionId,
                accessToken: tokens.accessToken,
                idToken: tokens.idToken,
                refreshToken: isNew ? tokens.refreshToken : this.refreshToken,
                accessExpiresAt: ctx.now + tokens.expiresAtSec,
                sessionExpiresAt: isNew ? ctx.now + ctx.refreshTokenTtlSec - 120 : this.sessionExpiresAt,
                salt: this.salt
            })
            return new SessionDataImpl(item, isNew, this.lockId)
        }

        /**
         * Save session data to the store. Typically called after making new session using {@link withTokens}.
         */
        async save() {
            const saveTokensCommand = new PutItemCommand({
                TableName: ctx.sessionTable,
                Item: {
                    'session_id': {S: this.sessionId},
                    'refresh_token': {S: this.refreshToken},
                    'expires_at': {N: `${this.accessExpiresAt}`},
                    'session_expires_at': {N: `${this.sessionExpiresAt}`},
                    'access_token': {S: this.accessToken},
                    'id_token': {S: this.idToken},
                    'salt': {S: this.salt},
                    'lock': {NULL: true}
                },
                ConditionExpression: "(" +
                    "attribute_not_exists(#sessionId)) " + //New record
                    "OR (#lock = :null OR #lockTill < :now) " + //No lock or expired lock
                    "OR (#lock = :lock)", //Our lock
                ExpressionAttributeNames: {
                    "#sessionId": "session_id",
                    "#lock": "lock",
                    "#lockTill": "lock_till"
                },
                ExpressionAttributeValues: {
                    ":null": {NULL: true},
                    ":lock": this.lockId ? {S: this.lockId} : {NULL: true},
                    ":now": {N: `${ctx.now}`},
                }
            })
            try {
                await dynamoDb.send(saveTokensCommand)
            } catch (e) {
                console.log(e)
                throw e
            }
        }

        /**
         * True if it is time to refresh access and/or id token.
         */
        get isTimeToRefresh(): boolean {
            const nextRefresh = ctx.now + ctx.cacheTtlSec
            return nextRefresh >= this.accessExpiresAt - 120
        }

        /**
         * Remove session data from the store
         */
        async remove() {
            const command = new DeleteItemCommand({
                TableName: ctx.sessionTable,
                Key: {'session_id': {S: this.sessionId}}
            })
            await dynamoDb.send(command)
        }

        /**
         * Create cookie for the session data
         */
        makeCookie() {
            const newSessionExpiresAt = ctx.now + ctx.refreshTokenTtlSec - 120
            const expiration = new Date(newSessionExpiresAt * 1000)
            return createSessionCookie(this.sessionId, expiration)
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

    return {
        loadAndLock: SessionDataImpl.loadAndLock,
        fromTokens: SessionDataImpl.fromTokens,
        dynamoDb
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
    return SessionItemSchema.parse(x)
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