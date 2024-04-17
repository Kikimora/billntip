import {createLockStore, LockHandle, LockStore, makeLockStore} from "@app/dynamodb/lock";
import {getCommand} from "@app/dynamodb";
import {unmarshall} from "@aws-sdk/util-dynamodb";
import {retry} from "@app/util";

beforeAll(async () => {
    try {
        await createLockStore("Locks")
    } catch (e) {
        //ignore
    }
})

describe("DynamoDb locks", () => {
    const options = {retries: 1, heartbeatInterval: 10, leaseDuration: 100};
    let store: LockStore
    let handles: LockHandle[] = []
    beforeAll(() => {
        store = makeLockStore("Locks")
    })

    afterAll(() => {
        jest.restoreAllMocks()
    })

    afterEach(async () => {
        for (const h of handles) {
            await h.unlock()
        }
        jest.resetAllMocks()
    })

    it("can lock", async () => {
        handles[0] = await store.lock("1", "can lock", options)
        const concurrentLock = store.tryLock("1", "another test")
        await expect(concurrentLock).toReject()
    })
    it("cannot lock twice", async () => {
        handles[0] = await store.lock("1", "cannot lock twice 1", options)
        const actual = store.lock("1", "cannot lock twice 2", options);
        await expect(actual).toReject()
    })
    it("can lock after unlock", async () => {
        handles[0] = await store.lock("1", "can lock after unlock 1", options)
        await handles[0].unlock()
        handles[1] = await store.lock("1", "can lock after unlock 2", options)
        expect(handles[1].locked).toBeTrue()
    })
    it("can lock another lock", async () => {
        handles[0] = await store.lock("1", "can lock another lock 1", options)
        handles[1] = await store.lock("2", "can lock another lock 2", options)
        expect(handles[0].locked).toBeTrue()
        expect(handles[1].locked).toBeTrue()
    })
    it("can unlock same lock multiple times", async () => {
        //lock and unlock
        handles[0] = await store.lock("1", "can unlock same lock multiple times 1", options)
        await handles[0].unlock()
        //take another lock and unlock OLD lock
        handles[1] = await store.lock("1", "can unlock same lock multiple times 1", options)
        await handles[0].unlock()
        //verify new lock still present
        const actual = store.lock("1", "can unlock same lock multiple times 2", options);
        await expect(actual).toReject()
    })

    async function loadLockItem(handle: LockHandle, version?: number) {
        return await retry(async function () {
            const {Item: dynamoItem} = await store.dynamoDb.send(getCommand(store.table, {
                key: {pk: handle.lock.pk}
            }))
            const item = unmarshall(dynamoItem!);
            if (version !== undefined && item.version < version) throw new Error("Old item")
            return item
        }, {maxIterations: 10, delay: 20})
    }

    it("set TTL", async () => {
        const handle = handles[0] = await store.lock("1", "lock", options)
        const now = Math.floor((performance.now() + performance.timeOrigin) / 1000)
        let lockItem = await loadLockItem(handle);
        expect(lockItem.ttl).toBeCloseTo(now + 5, 0)
    })
})

