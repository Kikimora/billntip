import {ConditionalCheckFailedException, CreateTableCommand, DynamoDB} from "@aws-sdk/client-dynamodb";
import {unmarshall} from "@aws-sdk/util-dynamodb";
import {D, Table, table} from "./schema";
import {updateCommand} from "./update";
import {Just, repeat, retry} from "../util";
import {deleteCommand} from "./delete";
import {Tracer, withErrorContext} from "../diagnostics";

const tracer = new Tracer("dynamodb_locks")

/**
 * Interface to a distributed lock store.
 */
export interface LockStore {
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
    tryLock(id: string, owner: string, options?: TryLockOptions): Promise<LockHandle>
}

/**
 * A handle to manage a lock.
 */
export interface LockHandle {
    /**
     * Remove lock
     */
    unlock(): Promise<void>

    /**
     * Synonym to {@link unlock}
     */
    [Symbol.dispose](): Promise<void>

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
    dynamodb?: DynamoDB
}

/**
 * Lock operation options (see {@link LockStore.lock})
 */
export type LockOptions = {
    /**
     * Duration of the lease. Default is 1000 ms.
     */
    leaseDuration?: number,
    /**
     * Heartbeat interval in ms used by a leaseholder to update the lease and signal it is alive.
     * Default is {@link leaseDuration} / 3
     */
    heartbeatInterval?: number
    /**
     * Maximum number of attempts to take the lock. Default is 3.
     */
    retries?: number
}

/**
 * Try lock operation options (see {@link LockStore.tryLock})
 */
export type TryLockOptions = Omit<LockOptions, 'retries'>

type Lock = Readonly<{
    pk: string
    version: number
    owner: string
    heartbeatInterval: number
}>

type TryLockResult = Just<Lock, "Success"> | Just<Lock, "Failure">

export const LockKey = {
    pk: D.String
} as const

export const LockAttributes = {
    version: D.Number,
    owner: D.String,
    heartbeat_interval: D.Number,
    ttl: D.Number
} as const

/**
 * Create DynamoDb table for lock storage.
 * @param tableName - DynamoDb table name
 * @param storeOptions - store options
 */
export async function createLockStore(tableName: string, storeOptions?: StoreOptions) {
    const dynamoDb = storeOptions?.dynamodb ?? new DynamoDB()
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

    const dynamoDb = storeOptions?.dynamodb ?? new DynamoDB()

    const Locks = table(tableName, LockKey, LockAttributes)
    const locker = new Locker(dynamoDb, Locks)

    return {
        tryLock: function (id: string, owner: string, options?: TryLockOptions) {
            return this.lock(id, owner, {...options, retries: 0})
        },

        async lock(id: string, owner: string, options?: LockOptions) {
            const leaseDuration = options?.leaseDuration ?? 1000
            if (leaseDuration <= 0) throw new Error("leaseDuration cannot be less than 1")
            const retries = options?.retries ?? 3
            if (retries < 0) throw new Error("retries cannot be less than 0")
            const heartbeatInterval = options?.heartbeatInterval ?? leaseDuration / 3
            if (heartbeatInterval >= leaseDuration)
                throw new Error("heartbeatInterval cannot be less that leaseDuration")

            let lock: Lock = {pk: id, owner, version: 1, heartbeatInterval}

            const lockImpl = new LockImpl(lock, locker)
            await lockImpl.acquireLock(retries)
            lockImpl.runHeartbeat()
            return lockImpl
        }
    }
}

/**
 * Keeps lock state, uses {@link Locker} to acquire, maintain and release the lock.
 */
class LockImpl implements LockHandle {
    private _otherLock?: Lock
    private _heartbeat: Promise<Lock>
    private _unlocked: boolean
    private _lock: Lock

    constructor(lock: Lock, private readonly locker: Locker) {
        this._lock = lock
        this._heartbeat = Promise.resolve<Lock>(lock)
        this._unlocked = false
    }

    get lock() {
        return this._lock
    }

    get locked() {
        return !this._unlocked
    }

    async acquireLock(maxIterations: number) {
        const delay = () => {
            return this._otherLock!.heartbeatInterval * 2
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
                return
            }
            case "Failure": {
                const otherLock = this._otherLock = value
                const error = new LockError("Failed to take a lock.")
                this._lock = {...lock, version: value.version + 1}
                throw withErrorContext(error, "tryLock", {lock, otherLock})
            }
        }
    }

    runHeartbeat() {
        const heartbeatTracer = tracer.withScope("runHeartbeat")
        const bump = async (done: (_: void) => void) => {
            if (this._unlocked) {
                heartbeatTracer.info("unlocked", this.lock)
                done()
                return
            }
            const {lock, locker} = this
            try {
                this._heartbeat = locker.bump(lock)
                this._lock = await this._heartbeat
            } catch (e: any) {
                heartbeatTracer.error(e, lock)
            }
        }
        // noinspection ES6MissingAwait,JSIgnoredPromiseFromCall
        repeat(bump, {delay: this.lock.heartbeatInterval})
    }

    async unlock() {
        const {locked, locker, _heartbeat} = this
        if (!locked) return
        this._unlocked = true
        await _heartbeat
        //Bump task changes lock, read it after bump task finishes
        const {lock} = this
        this._lock = await locker.deleteLock(lock)
    }

    async [Symbol.dispose]() {
        await this.unlock()
    }
}

/**
 * Provides low level lock operations.
 */
class Locker {
    constructor(private readonly dynamoDb: DynamoDB,
                private readonly table: Table<typeof LockKey, typeof LockAttributes>) {
    }

    async tryLock(lock: Lock): Promise<TryLockResult> {
        tryLock: try {
            const {Attributes: attributes} = await this.dynamoDb.send(updateCommand(this.table, {
                key: {pk: lock.pk},
                return: "ALL_NEW",
                values: lock,
                returnOnConditionFailure: "ALL_OLD",
                expression: ({attr, val}) => `SET
                            ${attr.version} = ${val.version},
                            ${attr.heartbeat_interval} = ${val.heartbeatInterval},
                            ${attr.ttl} = ${val(Math.floor((Date.now() + lock.heartbeatInterval * 2) / 2))},
                            ${attr.owner} = ${val.owner}`,
                condition: ({key, attr, val}) => `
                           attribute_not_exists(${key.pk}) OR ${attr.version} < ${val.version}`
            }))
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

    async bump(lock: Lock) {
        const {pk, version} = lock
        const command = updateCommand(this.table, {
            key: {pk},
            return: "ALL_NEW",
            expression: ({attr, val}) => `SET 
                            ${attr.version} = ${attr.version} + ${val(1)},
                            ${attr.ttl} = ${attr.ttl} + ${attr.heartbeat_interval}`,
            condition: ({key, attr, val}) =>
                `attribute_exists(${key.pk}) AND ${attr.version} = ${val(version)}`
        });
        const {Attributes: attributes} = await this.dynamoDb.send(command)
        if (attributes === undefined) throw new Error("Unexpected condition while bumping a lock version")
        const item = unmarshall(attributes)
        return fromDynamoDb(item)
    }

    async deleteLock(lock: Lock) {
        const {pk, version} = lock
        const {Attributes: attributes} = await this.dynamoDb.send(deleteCommand(this.table, {
            key: {pk},
            return: "ALL_OLD",
            condition: ({key, attr, val}) =>
                `attribute_exists(${key.pk}) AND ${attr.version} = ${val(version)}`
        }))
        if (attributes === undefined) {
            throw new Error("Unexpected condition while bumping a lock version")
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
        heartbeatInterval: lock.heartbeat_interval
    }
}
