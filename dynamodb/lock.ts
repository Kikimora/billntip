import {ConditionalCheckFailedException, CreateTableCommand, DynamoDB} from "@aws-sdk/client-dynamodb";
import {unmarshall} from "@aws-sdk/util-dynamodb";
import {TableSchema, table, Type} from "./schema";
import {update,} from "./update";
import {Just, repeat, retry} from "@app/util";
import {deleteItem} from "./delete";
import {Tracer, errorWithContext} from "@app/diagnostics";
import {get} from "./get";

const tracer = new Tracer("dynamodb_locks")

/**
 * Interface to a distributed lock store.
 */
export interface LockStore {

    /**
     * Lock table
     */
    readonly table: TableSchema<typeof LockKey, typeof LockAttributes>

    /**
     * DynamoDB client
     */
    readonly dynamoDb: DynamoDB

    /**
     * Acquire a lock with a given id. If lock is taken then wait and retry given number of times.
     * @param id - lock id
     * @param owner - lock owner, this value is used for information purposes and debug, good idea to put host, lambda invocation id or request id there.
     * @param options - lock options such as lease duration and heartbeat interval.
     */
    lock(id: string, owner: string, options?: LockOptions): Promise<LockHandle>

    /**
     * Try to acquire a lock once, fail if lock is taken.
     * @param id - lock id
     * @param owner - lock owner, this value is used for information purposes and debug, good idea to put host, lambda invocation id or request id there.
     * @param options - lock options such as lease duration and heartbeat interval.
     */
    tryLock(id: string, owner: string, options?: LockOptions): Promise<LockHandle>

    /**
     * Loads lock from store
     * @param id - lock id
     */
    load(id: string): Promise<Lock | undefined>;
}

/**
 * A handle to manage a lock.
 */
export interface LockHandle {
    /**
     * Remove lock
     */
    unlock(): Promise<boolean>

    /**
     * Increase lease duration by another {@link options.leaseDuration}.
     */
    bump(): Promise<Lock>

    /**
     * Synonym to {@link unlock}
     */
    [Symbol.dispose](): Promise<void>

    /**
     * Lock options.
     */
    readonly options: Readonly<NonNullable<LockOptions>>

    /**
     * Lock managed by the handle
     */
    readonly lock: Lock

    /**
     * Indicates whenever lock is taken
     */
    readonly locked: boolean
}

/**
 * Lock store options.
 */
export type StoreOptions = {
    /**
     * DynamoDb client to use
     */
    dynamoDb?: DynamoDB
}

/**
 * Lock operation options (see {@link LockStore.lock})
 */
export type LockOptions = {
    /**
     * Duration of the lease, minimum is 100 ms, default is 1000 ms.
     */
    leaseDuration?: number,
    /**
     * Maximum number of attempts to take the lock. Default is 3.
     */
    retries?: number
    /**
     *  Set whenever the lock should auto extend its lease before it expires. Default - true.
     */
    autoBump?: boolean
}

type TryLockOptions = Omit<LockOptions, 'retries'>

type Lock = Readonly<{
    /**
     * Lock identifier
     */
    pk: string
    /**
     * Lock version, increase with every heartbeat
     */
    version: number
    /**
     * Lock owner identifier
     */
    owner: string
    /**
     * Lease duration in milliseconds. The lease can be extended for another {@link leaseDuration} by {@link LockHandle.bump}
     */
    leaseDuration: number,
}>

type TryLockResult = Just<Lock, "Success"> | Just<Lock, "Failure">

export const LockKey = {
    pk: Type.String
} as const

export const LockAttributes = {
    version: Type.Number,
    owner: Type.String,
    lease_ms: Type.Number,
    ttl: Type.Number
} as const

/**
 * Create DynamoDb table for lock storage.
 * @param tableName - DynamoDb table name
 * @param storeOptions - store options
 */
export async function createLockStore(tableName: string, storeOptions?: StoreOptions) {
    const dynamoDb = storeOptions?.dynamoDb ?? new DynamoDB()
    await dynamoDb.send(new CreateTableCommand({
        TableName: tableName,
        KeySchema: [{KeyType: "HASH", AttributeName: "pk"}],
        AttributeDefinitions: Object.entries(LockKey).map(function ([k, v]) {
            return {AttributeType: v, AttributeName: k}
        }),
        BillingMode: "PAY_PER_REQUEST"
    }))
}

class LockError extends Error {
    constructor(message: string) {
        super(message)
    }
}

/**
 * Create lock store using a given table name and options.
 * @param tableName - lock table name
 * @param storeOptions - store options
 */
export function makeLockStore(tableName: string, storeOptions?: StoreOptions): LockStore {

    const dynamoDb = storeOptions?.dynamoDb ?? new DynamoDB()

    const Locks = table(tableName, LockKey, LockAttributes)
    const locker = new Locker(dynamoDb, Locks)

    return {
        table: Locks,
        dynamoDb,

        tryLock: function (id: string, owner: string, options?: TryLockOptions): Promise<LockHandle> {
            return this.lock(id, owner, {...options, retries: 1})
        },

        async lock(id: string, owner: string, options?: LockOptions): Promise<LockHandle> {
            const leaseDuration = options?.leaseDuration ?? 1000
            if (leaseDuration < 100) throw new Error("leaseDuration cannot be less than 100")
            const retries = options?.retries ?? 3
            if (retries <= 0) throw new Error("retries must be greater than 0")
            if (retries >= 1000) throw new Error("retries cannot be over 1000")
            const autoBump = options?.autoBump ?? true
            let lock: Lock = {pk: id, owner, version: 1, leaseDuration}
            const lockImpl = new LockImpl(lock, locker, {leaseDuration, retries, autoBump})
            await lockImpl.acquireLock(retries)
            if (autoBump)
                lockImpl.runHeartbeat()
            return lockImpl
        },

        async load(id: string): Promise<Lock | undefined> {
            try {
                return await locker.load(id)
            } catch (e: any) {
                tracer.info("Cannot find lock", {id, error: e})
                return undefined
            }
        }
    } as LockStore
}

/**
 * Keeps lock state, uses {@link Locker} to acquire, maintain and release the lock.
 */
class LockImpl implements LockHandle {
    private _otherLock?: Lock
    private heartbeatTask: Promise<Lock>
    private _isLocked: boolean
    private _lock: Lock

    constructor(lock: Lock, private readonly locker: Locker, public readonly options: NonNullable<LockOptions>) {
        this._lock = lock
        this.heartbeatTask = Promise.resolve<Lock>(lock)
        this._isLocked = false
    }

    get lock() {
        return this._lock
    }

    get locked() {
        return this._isLocked
    }

    async acquireLock(maxIterations: number) {
        const delay = () => {
            const {lock} = this
            /**
             * Delay happens if we cannot acquire a lock because somebody else holds it.
             * This is a race condition, other lock owner runs heartbeat on its own while we are trying to acquire it.
             * Because we don't want to get ahead of the owner we wait for at least other lock lease duration.
             */
            if (this._otherLock === undefined) {
                tracer.warn("Waiting for another lock is called while no other lock present.", {lock})
                return 0
            }
            return this._otherLock.leaseDuration + Math.random() * this._otherLock.leaseDuration
        }
        const options = {delay, maxIterations};
        await retry(this.tryLock.bind(this), options)
    }

    async tryLock() {
        const {lock, locker} = this
        this._otherLock = undefined
        const {type, value} = await locker.tryLock(lock)
        switch (type) {
            case "Success": {
                this._lock = value
                this._isLocked = true
                tracer.info("locked", this._lock)
                return
            }
            case "Failure": {
                const otherLock = this._otherLock = value
                const error = new LockError("Failed to take a lock.")
                this._lock = {...lock, version: value.version + 1}
                throw errorWithContext(error, "tryLock", {lock, otherLock})
            }
        }
    }

    async bump() {
        const {lock, locker} = this
        this._lock = await locker.bump(lock)
        return this._lock
    }

    async unlock(clean: boolean = true): Promise<boolean> {
        const {locker} = this
        if (!this.locked) return false
        //Bump task changes lock and interfere with delete, read it after bump task finishes
        //1. Signal to stop heartbeat, no more bumping!
        this._isLocked = false
        //2. Wait until the most recent bump finishes
        await this.heartbeatTask
        //3. Delete lock ignoring any errors
        const lock = clean ? await locker.deleteLock(this._lock).catch() : this._lock
        //4. finally, record a trace
        tracer.info("unlocked", this._lock)
        return this._lock.version === lock.version
    }

    runHeartbeat() {
        const heartbeatTracer = tracer.withScope("runHeartbeat")
        const bump = async (done: (_: void) => void) => {
            if (!this._isLocked) {
                heartbeatTracer.info("done", this.lock)
                done()
                return
            }
            //heartbeatTracer.info("bump", this.lock)
            try {
                this.heartbeatTask = this.bump()
                await this.heartbeatTask
            } catch (e: any) {
                heartbeatTracer.warn(e.message, this.lock)
                //there is a problem with lock or we cannot reach lock storage
                //either way lock is in undefined state and we should release it.
                //don't delete the lock since it might be taken by other process.
                await this.unlock(false)
            }
        }
        // noinspection ES6MissingAwait,JSIgnoredPromiseFromCall
        repeat(bump, {delay: this.lock.leaseDuration * 0.8})
    }

    async [Symbol.dispose]() {
        await this.unlock()
    }
}

/**
 * Lock expires in 5 heartbeat intervals but no less than in 5 seconds from now.
 */
function lockExpiration(lock: Lock) {
    const MinHeartbeats = 5
    const MinSeconds = 5
    const now = Math.floor((performance.now() + performance.timeOrigin) / 1000)
    const heartbeatsMs = MinHeartbeats * lock.leaseDuration
    return heartbeatsMs < MinSeconds * 1000 ? now + MinSeconds : now + Math.floor(heartbeatsMs / 1000)
}

/**
 * Provides low level lock operations.
 */
class Locker {
    constructor(private readonly dynamoDb: DynamoDB,
                private readonly table: TableSchema<typeof LockKey, typeof LockAttributes>) {
    }

    async tryLock(lock: Lock): Promise<TryLockResult> {
        tryLock: try {
            const expiresAt = lockExpiration(lock)
            const lockItem = update(this.table, {
                key: {pk: lock.pk},
                return: "ALL_NEW",
                values: {...lock, expiresAt},
                returnOnConditionFailure: "ALL_OLD",
                expression: ({attr, ref}) => `SET
                            ${attr.version} = ${ref('version')},
                            ${attr.lease_ms} = ${ref('leaseDuration')},
                            ${attr.ttl} = ${ref('expiresAt')},
                            ${attr.owner} = ${ref('owner')}`,
                condition: ({key, attr, ref}) => `
                           attribute_not_exists(${key.pk}) OR ${attr.version} < ${ref('version')}`
            });
            const {Attributes: attributes} = await this.dynamoDb.updateItem(lockItem)
            if (attributes === undefined) break tryLock;
            return {type: "Success", value: fromDynamoDb(unmarshall(attributes))}
        } catch (e) {
            if (!(e instanceof ConditionalCheckFailedException)) {
                throw e
            }
            const attributes = e.Item
            if (attributes === undefined) break tryLock;
            const dynamoDbLock = fromDynamoDb(unmarshall(attributes));
            return {type: "Failure", value: dynamoDbLock}
        }
        throw new Error("Unexpected error while acquiring lock " + lock.pk)
    }

    async load(pk: string): Promise<Lock | undefined> {
        const lockItem = get(this.table, {
            key: {pk}
        });
        const {Item: item} = await this.dynamoDb.getItem(lockItem)
        if (item === undefined) return undefined
        return fromDynamoDb(unmarshall(item))
    }

    async bump(lock: Lock): Promise<Lock> {
        const {pk, version} = lock
        const expiresAt = lockExpiration(lock)
        const command = update(this.table, {
            key: {pk},
            values: {expiresAt, version, one: 1},
            return: "ALL_NEW",
            expression: ({attr, ref}) => `SET 
                            ${attr.version} = ${attr.version} + ${ref('one')},
                            ${attr.ttl} = ${ref('expiresAt')}`,
            condition: ({key, attr, ref}) =>
                `attribute_exists(${key.pk}) AND ${attr.version} = ${ref('version')}`
        });
        const {Attributes: attributes} = await this.dynamoDb.updateItem(command)
        if (attributes === undefined) throw new Error("Unexpected condition while bumping a lock version")
        const item = unmarshall(attributes)
        return fromDynamoDb(item)
    }

    async deleteLock(lock: Lock) {
        const {pk, version} = lock
        const {Attributes: attributes} = await this.dynamoDb.deleteItem(deleteItem(this.table, {
            key: {pk},
            values: {version},
            return: "ALL_OLD",
            condition: ({key, attr, ref}) =>
                `attribute_exists(${key.pk}) AND ${attr.version} = ${ref('version')}`
        }))
        if (attributes === undefined) {
            throw new Error("Unexpected condition while removing a lock")
        }
        const item = unmarshall(attributes)
        return fromDynamoDb(item)
    }
}

function fromDynamoDb(lock: Record<string, any>): Lock {
    return {
        pk: lock.pk,
        version: lock.version,
        owner: lock.owner,
        leaseDuration: lock.lease_ms
    }
}
