import {createLockStore, LockHandle, LockStore, makeLockStore} from "../../src/dynamodb/lock";
import {startTracingSession, Tracer, TracingSession} from "../../src/diagnostics";

let tracer = startTracingSession({immediateMode: true})
beforeAll(async () => {
    try {
        await createLockStore("Locks")
    } catch (e: any) {
        tracer.trace("Lock setup " + e.message)
    }
})

describe("DynamoDb locks", () => {
    const options = {retries: 1, heartbeatInterval: 10, leaseDuration: 100};
    let store: LockStore
    let handles: LockHandle[] = []
    beforeEach(() => {
        store = makeLockStore("Locks")
    })

    afterEach(async () => {
        for (const h of handles) {
            await h.unlock()
        }
        tracer.done()
    })
    it("can lock", async () => {
        try {
            handles[0] = await store.lock("1", "test", options)
            const concurrentLock = store.tryLock("1", "another test")
            await expect(concurrentLock).toReject()
        } catch (e) {
            tracer.error(e, "test " + __filename + " ")
            throw e
        }
    })
    it("cannot lock twice", async () => {
        handles[0] = await store.lock("1", "First", options)
        const actual = store.lock("1", "Second", options);
        await expect(actual).toReject()
    })
    it("can lock after unlock", async () => {
        handles[0] = await store.lock("1", "First", options)
        await handles[0].unlock()
        handles[1] = await store.lock("1", "Second", options)
        expect(handles[1].locked).toBeTrue()
    })
    it("can lock another lock", async () => {
        handles[0] = await store.lock("1", "First", options)
        handles[1] = await store.lock("2", "Second", options)
        expect(handles[0].locked).toBeTrue()
        expect(handles[1].locked).toBeTrue()
    })
})