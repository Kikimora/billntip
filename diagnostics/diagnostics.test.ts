import diagnostics, {EMF, EventRecorder, Trace, Tracer} from "@app/diagnostics"

let tracer: Tracer
let recorder: EventRecorder
let recordEvent: jest.SpyInstance;

describe("EventRecorder", () => {
    let mocks: any
    beforeEach(() => {
        mocks = {
            log: jest.spyOn(global.console, 'log'),
            info: jest.spyOn(global.console, 'log'),
            warn: jest.spyOn(global.console, 'warn'),
            error: jest.spyOn(global.console, 'error'),
        }
        recorder = new EventRecorder({})
    })
    afterEach(() => {
        jest.clearAllMocks()
    })

    it.each([
        ["log", "info"],
        ["warn", "warn"],
        ["error", "error"],
    ])("log events using console.%s", (method: any, level: any) => {
        recorder.recordEvent({level, tag: "test", message: "message", attributes: {attr: "value"}})
        expect(mocks[method]).toHaveBeenCalledWith({
            '@t': "test",
            '@m': "message",
            '@ts': expect.closeTo(Date.now(), -2),
            attr: "value",
        })
    })

    it("log error details", () => {
        const error = new Error("This is error")
        recorder.recordEvent({level: "error", tag: "test", error, message: "Error!", attributes: {attr: "value"}})
        expect(mocks.error).toHaveBeenCalledWith({
            '@t': "test",
            '@m': "Error!",
            '@ts': expect.closeTo(Date.now(), -2),
            errorType: "Error",
            errorMessage: "This is error",
            stackTrace: error.stack!.split('\n'),
            errorContext: {attr: "value"},
        })
    })

    it.each([
        ["info", {tag: "test"}],
        ["warn", {message: {$startsWith: "Hello"}}],
        ["error", {attributes: {event: {type: "test"}}}],
    ])("filter %s logs using %j", (level: any, filter: any) => {
        const filters = {[level]: filter}
        recorder = new EventRecorder({filters})
        recorder.recordEvent({
            level,
            tag: "test",
            message: "Hello World",
            attributes: {event: {type: "test"}}
        })
        expect(mocks[level]).not.toHaveBeenCalled()
    })

    it("defaults to immediate mode", () => {
        expect(recorder.mode).toBe("immediate")
    })

    it.each([
        ["info", {tag: "test"}],
        ["warn", {message: {$startsWith: "Hello"}}],
        ["error", {attributes: {event: {type: "test"}}}],
    ])("switches to immediate mode on %s trigger", (level: any, trigger: any) => {
        const triggers = {[level]: trigger}
        recorder = new EventRecorder({triggers})
        recorder.reset("accumulating")
        recorder.recordEvent({
            level,
            tag: "test",
            message: "Hello World",
            attributes: {event: {type: "test"}}
        })
        expect(recorder.mode).toBe("immediate")
    })

    it("switches to immediate on error", () => {
        recorder.reset("accumulating")
        recorder.recordEvent({level: "error", tag: "", message: "", attributes: {}})
        expect(recorder.mode).toBe("immediate")
    })

    it("dumps all collected logs when switches from sessions to immediate", () => {
        recorder.reset("accumulating")
        recorder.recordEvent({level: "info", tag: "", message: "1", attributes: {}})
        recorder.recordEvent({level: "info", tag: "", message: "2", attributes: {}})
        recorder.recordEvent({level: "error", tag: "", message: "3", attributes: {}})
        expect(recorder.mode).toBe("immediate")
        expect(mocks.info.mock.calls).toEqual([
            [expect.objectContaining({'@m': "1"})],
            [expect.objectContaining({'@m': "2"})]
        ])
        expect(mocks.error.mock.calls).toEqual([
            [expect.objectContaining({'@m': "3"})]
        ])
    })

    it("accumulate events", () => {
        recorder.reset("accumulating")
        const traces: Trace[] = [
            {level: "info", tag: "", message: "1", attributes: {}},
            {level: "info", tag: "", message: "2", attributes: {}}
        ]
        recorder.recordEvent(traces[0])
        recorder.recordEvent(traces[1])
        const events = Array.from(recorder.events)
        expect(events).toEqual(traces)
    })

    describe("keeps trace size reasonable", () => {
        it("has minimum trace size of 1000", () => {
            recorder = new EventRecorder({maxTraceSize: 10, mode: "accumulating"})
            expect(recorder.config.maxTraceSize).toBe(1000)
        })
        it("has default trace size of 10000", () => {
            recorder = new EventRecorder({mode: "accumulating"})
            expect(recorder.config.maxTraceSize).toBe(10000)
        })
        it("removes old events on overflow in batches of 100", () => {
            recorder = new EventRecorder({maxTraceSize: 1000, mode: "accumulating"})
            for (let i = 0; i < 1000; ++i) {
                recorder.recordEvent({level: "info", tag: "", message: `${i}`, attributes: {}})
            }
            let events = Array.from(recorder.events)
            expect(events.length).toBe(1000)

            recorder.recordEvent({level: "info", tag: "", message: "1001", attributes: {}})
            events = Array.from(recorder.events)
            expect(events.length).toBe(901)
            expect(events[0].message).toBe("100")
            expect(events[900].message).toBe("1001")
        })
    })
})

describe("Tracer", () => {
    beforeEach(() => {
        diagnostics({})
        tracer = new Tracer("test")
        recordEvent = jest.spyOn(tracer as any, 'recordEvent')
    })
    afterEach(() => {
        jest.clearAllMocks()
    })

    it.each([
        ["info", function (t: Tracer) {
            t.info("trace message", {attr: "value"})
        }],
        ["warn", function (t: Tracer) {
            t.warn("trace message", {attr: "value"})
        }],
        ["error", function (t: Tracer) {
            t.error("trace message", {attr: "value"})
        }],
    ])("record %s events", (level, method) => {
        method(tracer)
        expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
            tag: "test",
            level: level,
            message: "trace message",
            attributes: {attr: "value"}
        }))
    })

    it.each([
        ["text", "this is an error", {message: "this is an error"}],
        ["error", new Error("Error"), {message: "Error", error: expect.any(Error)}],
        ["object", {"attr": "value"}, {message: JSON.stringify({"attr": "value"})}],
    ])("record various types of errors - %s", (_, e, logged) => {
        tracer.error(e)
        expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
            tag: "test",
            level: "error",
            ...logged
        }))
    })

    it("creates hierarchical tags", () => {
        const t = tracer.withScope("scope1").withScope("scope2")
        const recordEvent = jest.spyOn(t as any, 'recordEvent')
        t.info("Hello World")
        expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
            tag: "test.scope1.scope2"
        }))
    })

    it("adds context to errors and logs it on tracer.error", () => {
        const libraryTracer = new Tracer("library")

        try {
            faultyFunction("faultyParameter")
        } catch (e: any) {
            tracer.error(e, {attr: "value"})
        }

        expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
            tag: "test",
            level: "error",
            error: expect.any(Error),
            message: "Something wrong",
            attributes: [
                {"tag": "test", "attr": "value"},
                {"tag": "library", "param": "faultyParameter"}
            ],
            ts: expect.any(Number)
        }))

        function faultyFunction(param: string) {
            try {
                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Something wrong")
            } catch (e: any) {
                throw libraryTracer.errorWithContext(e, {param})
            }
        }
    })

    describe("startSession", () => {
        let session: any
        beforeEach(() => {
            diagnostics({triggers: {request: {event: {attr: "value"}}}})
        })

        afterEach(() => {
            session.done()
        })

        it("force accumulating mode", async () => {
            expect(tracer.mode).toBe("immediate")

            session = tracer.startSession("request", {})
            expect(tracer.mode).toBe("accumulating")
            expect(session.mode).toBe("accumulating")
            session.done()

            expect(tracer.mode).toBe("immediate")
            expect(session.mode).toBe("immediate")
        })

        it("force immediate mode if event matches request trigger", () => {
            session = tracer.startSession("request", {attr: "value"})
            expect(session.mode).toBe("immediate")
            session.done()
        })

        it("force immediate mode if important event is recorded", () => {
            session = tracer.startSession("request", {})
            session.error("Some important event")
            expect(session.mode).toBe("immediate")
        })
    })
})

describe("EMF", () => {
    const metricsBuilder = EMF.namespace("test")
        .dimensions("functionName", "functionVersion")
        .metric("latency", {units: "Milliseconds"})
        .metric("callCount", {units: "Count", dimensions: ["functionName"], storageResolution: 1})
    let stdout!: jest.SpyInstance;
    let metrics!: ReturnType<typeof metricsBuilder.startReporter>;

    beforeEach(() => {
        metrics = metricsBuilder.startReporter()
        metrics.setDimensions({
            functionVersion: "$LATEST",
            functionName: "test"
        })
        stdout = jest.spyOn(process.stdout, "write")
    })

    afterEach(() => {
        metrics.stop()
        jest.clearAllMocks()
    })

    it("accept metrics as numbers and array of numbers and reports them in batches", () => {
        metrics.latency(10)
        metrics.callCount([2, 1])
        metrics.latency([10, 20])
        metrics.callCount(1)
        metrics.reportMetrics()
        const emf = metricReports()[0]
        expect(emf).toEqual(expect.objectContaining({
            latency: [10, 10, 20],
            callCount: [2, 1, 1],
            functionVersion: "$LATEST",
            functionName: "test",
            _aws: {
                Timestamp: expect.closeTo(Date.now(), -2),
                CloudWatchMetrics: [
                    {
                        Namespace: "test",
                        Dimensions: expect.arrayContaining([
                            ["functionName", "functionVersion"],
                            ["functionName"]
                        ]),
                        Metrics: [
                            {
                                "Name": "latency",
                                "Unit": "Milliseconds"
                            }, {
                                "Name": "callCount",
                                "Unit": "Count",
                                "StorageResolution": 1
                            }
                        ]
                    }
                ]
            }
        }))
    })

    it("split large arrays into smaller chunks", () => {
        const largeArray = Array.from({length: 250}, (_, i) => i + 1)
        metrics.latency(largeArray)
        const reports = metricReports()
        expect(reports[0]).toEqual(expect.objectContaining({
            latency: Array.from({length: 100}, (_, i) => i + 1)
        }))
        expect(reports[1]).toEqual(expect.objectContaining({
            latency: Array.from({length: 100}, (_, i) => i + 101)
        }))
    })


    it("reports when dimensions change", () => {
        metrics.latency(10)
        metrics.setDimensions({
            functionVersion: "1",
            functionName: "new"
        })
        expect(metricReports()).toHaveLength(1)
    })

    it("report on overflow", () => {
        for (let i = 0; i < 101; ++i) {
            metrics.latency(1)
        }
        expect(metricReports()).toHaveLength(1)
    })

    it("does not report without metrics", () => {
        metrics.reportMetrics()
        expect(metricReports()).toHaveLength(0)
    })

    it("reportMetrics throws if called without dimensions", () => {
        const metrics = metricsBuilder.startReporter()
        try {
            expect(function () {
                metrics.latency(1)
                metrics.reportMetrics()
            }).toThrow()
        } finally {
            metrics.stop()
        }
    })

    describe("metrics lookup", () => {
        it("by namespace and metric name", () => {
            const reporter = EMF.lookup("test", "latency")
            reporter.latency(1)
            metrics.reportMetrics()
            expect(metricReports()).toHaveLength(1)
        })
        it("makes noop reporter on unknown namespace", () => {
            const reporter = EMF.lookup("unknown", "latency", "callCount")
            reporter.latency(1)
            reporter.callCount(1)
            metrics.reportMetrics()
            expect(metricReports()).toHaveLength(0)
        })
        it("makes noop reporter on unknown metrics", () => {
            const reporter = EMF.lookup("test", "unknown")
            reporter.unknown(1)
            metrics.reportMetrics()
            expect(metricReports()).toHaveLength(0)
        })
    })

    it("cannot build same namespace twice", () => {
        expect(function () {
            EMF.namespace("test").metric("test", {units: "Seconds"})
        }).toThrow()
    })

    function metricReports() {
        return stdout.mock.calls.filter(x => x[0].includes("_aws")).map(x => JSON.parse(x[0]))
    }
})

