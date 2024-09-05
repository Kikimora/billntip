import {CreateTableCommand, DynamoDB} from "@aws-sdk/client-dynamodb";
import {Just, repeat, retry} from "@app/util";
import {Tracer, errorWithContext} from "@app/diagnostics";
import {internalError} from "@app/lambda";
import * as DDB from "./commands";

const tracer = new Tracer("dynamodb_locks")

/**
 * Interface to a distributed lock store.
 */
export interface Store {

    /**
     * Lock table
     */
    readonly table: DDB.Table<LocksTable>

    /**
     * Acquire a lock with a given id. If lock is taken then wait and retry given number of times.
     * @param id - lock id
     * @param owner - lock owner, this value is used for information purposes and debug, good idea to put host, lambda invocation id or request id there.
     * @param options - lock options such as lease duration and heartbeat interval.
     */
    lock(id: string, owner: string, options?: LockOptions): Promise<Handle>

    /**
     * Try to acquire a lock once, fail if lock is taken.
     * @param id - lock id
     * @param owner - lock owner, this value is used for information purposes and debug, good idea to put host, lambda invocation id or request id there.
     * @param options - lock options such as lease duration and heartbeat interval.
     */
    tryLock(id: string, owner: string, options?: LockOptions): Promise<Handle>

    /**
     * Loads lock from store
     * @param id - lock id
     */
    load(id: string): Promise<Lock | undefined>;
}

/**
 * A handle to manage a lock.
 */
export interface Handle {
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
 * Lock operation options (see {@link Store.lock})
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
     * Lease duration in milliseconds. The lease can be extended for another {@link leaseDuration} by {@link Handle.bump}
     */
    leaseDuration: number,
}>

type TryLockResult = Just<Lock, "Success"> | Just<Lock, "Failure">

const LockKey = DDB.Key({
    pk: DDB.String
})

const LockAttributes = DDB.Item({
    version: DDB.Number,
    owner: DDB.String,
    lease_ms: DDB.Number,
    ttl: DDB.Number
})

const LocksTable = {
    key: LockKey,
    item: LockAttributes
} as const

type LocksTable = (typeof LocksTable)

/**
 * Create DynamoDb table for lock storage.
 * @param tableName - DynamoDb table name
 * @param storeOptions - store options
 */
export async function createStore(tableName: string, storeOptions?: StoreOptions) {
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
export function makeStore(tableName: string, storeOptions?: StoreOptions): Store {

    const dynamoDb = storeOptions?.dynamoDb ?? new DynamoDB()
    const d = DDB.dynamodb({db: dynamoDb})
    const LocksTable = d.table(tableName, {
        key: LockKey,
        item: LockAttributes
    })
    const locker = new Locker(LocksTable)

    return {
        table: LocksTable,

        tryLock: function (id: string, owner: string, options?: TryLockOptions): Promise<Handle> {
            return this.lock(id, owner, {...options, retries: 1})
        },

        async lock(id: string, owner: string, options?: LockOptions): Promise<Handle> {
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
    } as Store
}

/**
 * Keeps lock state, uses {@link Locker} to acquire, maintain and release the lock.
 */
class LockImpl implements Handle {
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
        const lock = clean ? await locker.deleteLock(this._lock).catch() ?? this._lock : this._lock
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
    constructor(private readonly locksTable: DDB.Table<LocksTable>) {
    }

    async tryLock(lock: Lock): Promise<TryLockResult> {
        const {locksTable} = this
        const expiresAt = lockExpiration(lock)
        const response = await locksTable.update({
            key: {pk: lock.pk},
            return: "ALL_NEW",
            returnOnConditionFailure: "ALL_OLD",
            expression: ({attr, ref}) => ({
                set: {
                    [attr.version]: ref('version'),
                    [attr.lease_ms]: ref('leaseDuration'),
                    [attr.ttl]: ref('expiresAt'),
                    [attr.owner]: ref('owner'),
                }
            }),
            condition: ({key, attr, ref}) =>
                `attribute_not_exists(${key.pk}) OR ${attr.version} < ${ref('version')}`
        }, {...lock, expiresAt})
        if (!response.ConditionCheckFailed) {
            const lockItem = response.Attributes
            return {type: "Success", value: fromDynamoDbTable(lockItem)}
        } else {
            const oldLock = response.FailedAttributes
            if (oldLock === undefined) {
                throw internalError("Unexpected error while acquiring lock").withContext("tryLock", {lock})
            }
            return {type: "Failure", value: fromDynamoDbTable(oldLock)}
        }
    }

    async load(pk: string): Promise<Lock | undefined> {
        const {Item: lockItem} = await this.locksTable.get({key: {pk}})
        if (lockItem === undefined) return undefined
        return fromDynamoDbTable(lockItem)
    }

    async bump(lock: Lock): Promise<Lock> {
        const {pk, version} = lock
        const expiresAt = lockExpiration(lock)
        const response = await this.locksTable.update({
            key: {pk},
            return: "ALL_NEW",
            expression: ({attr, ref}) => `SET 
                            ${attr.version} = ${attr.version} + ${ref('one')},
                            ${attr.ttl} = ${ref('expiresAt')}`,
            condition: ({key, attr, ref}) =>
                `attribute_exists(${key.pk}) AND ${attr.version} = ${ref('version')}`
        }, {expiresAt, version, one: 1})
        if (response.ConditionCheckFailed)
            throw internalError().withContext("bump", {lock, conflictingLock: response.FailedAttributes})
        return fromDynamoDbTable(response.Attributes)
    }

    async deleteLock(lock: Lock) {
        const {pk, version} = lock
        const response = await this.locksTable.delete({
            key: {pk},
            return: "ALL_OLD",
            condition: ({key, attr, ref}) =>
                `attribute_exists(${key.pk}) AND ${attr.version} = ${ref('version')}`
        }, {version})
        if (response.ConditionCheckFailed)
            throw internalError("Cannot remove lock. It is either not found or versions do not match")
                .withContext("deleteLock", {lock, conflictingLock: response.FailedAttributes})
        const lockItem = response.Attributes;
        if (lockItem === undefined) {
            throw new Error("Lock not found")
        }
        return fromDynamoDbTable(lockItem)
    }
}

function fromDynamoDbTable(lock: DDB.ItemType<DDB.Table<LocksTable>>): Lock {
    return {
        pk: lock.pk,
        version: lock.version,
        owner: lock.owner,
        leaseDuration: lock.lease_ms
    }
}
