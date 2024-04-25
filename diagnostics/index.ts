import {clearInterval} from "node:timers";
import {Serializable} from "node:worker_threads";
import {AsyncLocalStorage} from "node:async_hooks";
import {Context, APIGatewayProxyEvent} from "aws-lambda"
import _ from "lodash";
import {CompiledSchema, compileSchema, Schema} from "./matcher";

export type TraceAttributes = { [k: string]: Serializable | undefined | null }
export type ErrorContext = { name: string, value?: TraceAttributes }

/**
 * Metric measurement units
 */
type Units =
    "Seconds"
    | "Microseconds"
    | "Milliseconds"
    | "Bytes"
    | "Kilobytes"
    | "Megabytes"
    | "Gigabytes"
    | "Terabytes"
    | "Bits"
    | "Kilobits"
    | "Megabits"
    | "Gigabits"
    | "Terabits"
    | "Percent"
    | "Count"
    | "Bytes/Second"
    | "Kilobytes/Second"
    | "Megabytes/Second"
    | "Gigabytes/Second"
    | "Terabytes/Second"
    | "Bits/Second"
    | "Kilobits/Second"
    | "Megabits/Second"
    | "Gigabits/Second"
    | "Terabits/Second"
    | "Count/Second"
    | "None"
/**
 * Metric storage resolution
 */
type StorageResolution = 1 | 60
/**
 * EMF CloudWatch metrics directive. See [details]{@link https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html#CloudWatch_Embedded_Metric_Format_Specification_structure_metricdirective.} in the AWS docs.
 */
type EMFMetricDirective = {
    Namespace: string,
    Dimensions: string[][],
    Metrics: {
        Name: string,
        Unit: Units,
        StorageResolution: StorageResolution | undefined
    }[]
}

/**
 * Interface to report metric dimensions.
 */
export interface EMFDimensionsReporter<Dimensions extends string> {
    /**
     * Set dimensions to be reported later on, once metric reporter decides it is time to report.
     * @param dimensionValues - metric dimension values
     */
    setDimensions(dimensionValues: { [key in Dimensions]: string }): void
}

/**
 * Interface to report metric values.
 */
export type EMFMetricsReporter<Metrics extends string> = {
    /**
     * Reports individual metric value or array of values.
     */
    [key in Metrics]: (val: number | number[]) => void
}

export interface EMFMetricsCollector {
    stop(): void

    [Symbol.dispose](): void

    reportMetrics(): void
}

/**
 * Metric options
 */
interface MetricOptions<Dimensions extends string> {
    /**
     * Metric units
     */
    units: Units,
    /**
     * A subset of dimensions defined by {@link EMF.dimensions}. Default - all dimensions.
     */
    dimensions?: Dimensions[],
    /**
     * Metric storage resolution. Default - 60
     */
    storageResolution?: StorageResolution
}

/**
 * Builder class for  {@link EMFDimensionsReporter} and {@link EMFMetricsReporter} implementation.
 */
export class EMF<Metrics extends string = never, Dimensions extends string = never> {

    private _defaultDimensions: string[] = []
    private cloudWatch: EMFMetricDirective = {
        Namespace: "NoName",
        Dimensions: [],
        Metrics: [],
    }

    private constructor(namespace: string) {
        this.cloudWatch.Namespace = namespace
    }

    /**
     * Sets metrics namespace
     * @param ns - metrics namespace
     */
    static namespace(ns: string) {
        return new EMF(ns)
    }

    private static collectors: Record<string, any> = {}
    private static Metrics = Symbol("metrics")

    /**
     * Lookup pre-built {@link EMFMetricsReporter} implementation. If requested reporter is not found this function
     * returns noop reporter and writes a warning to EMF tracer.
     * @param ns - metrics namespace
     * @param metrics - set of metrics
     * @returns either pre-built metrics reporter or noop reporter.
     */
    static lookup<M extends string>(ns: string, ...metrics: M[]): EMFMetricsReporter<M> {
        const reporter = EMF.collectors[ns]
        if (reporter === undefined) {
            EMFTracer.warn("Cannot find a metrics reporter for the namespace. Returning noop reporter.", {ns, metrics})
            return makeNoOpReporter()
        }
        for (const key of metrics) {
            if (!(key in reporter)) {
                EMFTracer.warn("Reporter for the namespace exists but does not support all requested metrics. Returning noop reporter.", {
                    ns,
                    metrics,
                    supportedMetrics: reporter[EMF.Metrics]
                })
                return makeNoOpReporter()
            }
        }
        return reporter

        function makeNoOpReporter() {
            const noop: any = {}
            for (const key of metrics) {
                noop[key] = _.noop
            }
            return noop
        }
    }

    /**
     * Specify set of dimensions available to metrics.
     * @param dimensions - set of dimensions
     */
    dimensions<D extends string>(...dimensions: D[]): EMF<Metrics, typeof dimensions[number]> {
        this.assertNotBuilt();
        this._defaultDimensions = dimensions
        return this as any as EMF<Metrics, typeof dimensions[number]>
    }

    /**
     * Define a metric.
     * @param name - metric name
     * @param options - metric options dimensions
     */
    metric<M extends string>(name: M, options: MetricOptions<Dimensions>): EMF<Metrics | M, Dimensions> {
        this.assertNotBuilt()
        const dimensions = options.dimensions ?? this._defaultDimensions
        const units = options.units
        const storageResolution = options.storageResolution ?? 60
        this.cloudWatch.Dimensions.push(dimensions)
        this.cloudWatch.Metrics.push({
            Name: name,
            Unit: units,
            StorageResolution: storageResolution == 60 ? undefined : storageResolution
        })
        return this as EMF<Metrics | M, Dimensions>
    }

    /**
     * Build and starts a metric reporter - combination of {@link EMFMetricsReporter} and {@link EMFDimensionsReporter}.
     * Reporter batches metrics and writes them if over 100 metric values reported, a minute interval passes on runtime shutdown.
     *
     * Call {@link stop} when you don't longer need it.
     */
    startReporter(): EMFMetricsReporter<Metrics> & EMFDimensionsReporter<Dimensions> & EMFMetricsCollector {
        type DimensionValues = { [key in Dimensions]: string }
        type Collector = EMFMetricsReporter<Metrics> & EMFDimensionsReporter<Dimensions> & EMFMetricsCollector

        const stream: NodeJS.WriteStream = process.stdout
        const {cloudWatch} = this
        let metricValues: any = {}
        let dimensionValues: DimensionValues | undefined
        const dimensions: EMFDimensionsReporter<Dimensions> = {
            setDimensions(dimensions: DimensionValues): void {
                if (dimensionValues !== undefined && !_.isEqual(dimensionValues, dimensions)) {
                    EMFTracer.warn("Dimensions has changed, reporting metrics prematurely", {
                        old: dimensions, new: dimensionValues
                    })
                    reportMetrics("dimensions changed")
                }
                dimensionValues = dimensions
            },
            [EMF.Metrics]: cloudWatch.Metrics.map(x => x.Name)
        }
        const metricsReporter: Partial<EMFMetricsReporter<Metrics>> = {}
        for (const metric of cloudWatch.Metrics) {
            metricValues[metric.Name] = []
            metricsReporter[metric.Name as Metrics] = makeMetricRecorder(metric.Name)
        }

        const onShutdown = function () {
            reportMetrics("SIGTERM - Runtime shutdown")
            stop()
        }
        process.on('SIGTERM', onShutdown)

        const interval = setInterval(() => {
            reportMetrics("1 min timer")
        }, 60 * 1000)

        function stop() {
            clearInterval(interval)
            process.off('SIGTERM', onShutdown)
        }

        function reportMetrics(reason: string = "manual") {
            const events = _.sum(cloudWatch.Metrics.map((metric) => metricValues[metric.Name].length))
            if (events === 0) return
            EMFTracer.info("reportMetrics", {reason, events})

            if (dimensionValues == undefined && cloudWatch.Dimensions.length > 0) {
                throw EMFTracer.errorWithContext(
                    new Error("cannot report metrics without dimensions"), {
                        dimensions: cloudWatch.Dimensions,
                        reason
                    })
            }

            //See https://docs.aws.amazon.com/lambda/latest/dg/nodejs-logging.html#nodejs-logging-advanced-emf
            stream.write(JSON.stringify({
                ...dimensionValues,
                ...metricValues,
                _aws: {
                    Timestamp: performance.now() + performance.timeOrigin,
                    "CloudWatchMetrics": [cloudWatch]
                }
            }) + "\n")
            for (const metric of cloudWatch.Metrics) {
                metricValues[metric.Name].splice(0)
            }
        }

        function makeMetricRecorder(metric: string) {
            let values = metricValues[metric]
            return function (val: number | number[]) {
                if (typeof val === "number") {
                    if (values.length + 1 > 100) {
                        EMFTracer.info("metric overflow", {metric})
                        reportMetrics("metric overflow")
                    }
                    values.push(val)
                } else {
                    let batch: number[]
                    //Pick as many values as possible from val, if something left then we overflow.
                    while ((batch = val.splice(0, 100 - values.length)) && val.length > 0) {
                        values.push(...batch)
                        EMFTracer.info("metric overflow", {metric})
                        reportMetrics("metric overflow")
                    }
                    values.push(...batch)
                }
            }
        }

        const collector: Collector = {
            ...dimensions,
            ...metricsReporter as EMFMetricsReporter<Metrics>,
            reportMetrics,
            stop,
            [Symbol.dispose]: stop
        }
        EMF.collectors[cloudWatch.Namespace] = collector
        return collector
    }

    private assertNotBuilt() {
        if (EMF.collectors[this.cloudWatch.Namespace] !== undefined)
            throw new Error("Metrics reporter already registered for namespace " + this.cloudWatch.Namespace)
    }
}

/**
 * Trace levels. There is no usual debug or trace levels because AWS Lambda NodeJS runtime `console` only reports these three levels.
 */
type TraceLevel = "info" | "warn" | "error"

/**
 * A trace - snapshot of a portion the program execution. Trace properties and {@link attributes} except
 * {@link level} are logged inside 'message' property of the Cloud Watch JSON event. {@link level}
 * is logged as the top level 'level' property.
 *
 * ```js
 * tracer.info("message", {attr:"value"})
 * ```
 * Produce
 * ```json
 * {
 *  "timestamp": "2023-12-08T23:21:04.664Z",
 *  "level": "INFO",
 *  "requestId": "405a4537-9226-4216-ac59-64381ec8654a",
 *  "message": { "attr": "value" }
 * }
 * ```
 */
export interface Trace {
    /**
     * Trace attributes, added into the logged event. Good place to put input parameters, results and intermediate values.
     */
    readonly attributes: TraceAttributes
    /**
     * Trace tag, logged as '@t', used to identify module or subsystem producing the trace. Tags can be hierarchical,
     * e.g. myModule.myFunction. See {@link Tracer.withScope} for details.
     */
    readonly tag: string
    /**
     * Trace message, logged as '@m'
     */
    readonly message: string
    /**
     * Trace error, optional, can be present only if {@link level} is 'error'. When present adds 'errorType',
     * 'errorMessage', 'errorContext' and 'stackTrace' attributes.
     */
    readonly error?: any
    /**
     * Trace level, logged as top level 'level' attribute.
     */
    readonly level: TraceLevel,
}

/**
 * Options controlling how traces are collected and reported.
 */
export interface TracingOptions {
    /**
     * Collection of triggers controlling when request traces written into the store. See also {@link Tracer}.
     */
    triggers?: {
        /**
         * Trigger matching schema against [info]{@link TraceLevel} traces. Default - false.
         */
        info?: Schema | boolean
        /**
         * Trigger matching schema against [warn]{@link TraceLevel} traces. Default - false.
         */
        warn?: Schema | boolean
        /**
         * Trigger matching schema against [error]{@link TraceLevel} traces. Default - true, meaning any error triggers log dump.
         */
        error?: Schema | boolean
        /**
         * Trigger running at the start of the request against an object of shape {[event]{@link APIGatewayProxyEvent}, [context]{@link ErrorContext}}. Default - false.
         */
        request?: Schema | boolean
    },
    /**
     * Collection of filters discarding events.
     */
    filters?: {
        /**
         * Write accumulated logs and switch to immediate mode if any trace event matches this matcher.
         */
        info?: Schema | boolean
        /**
         * Write accumulated logs and switch to immediate mode if any metric event matches this matcher.
         */
        warn?: Schema | boolean
        /**
         * Write accumulated logs and switch to immediate mode if any error event matches this matcher. Default - true, meaning any error matches.
         */
        error?: Schema | boolean
    },

    /**
     * Maximum number of events to collect
     */
    maxTraceSize?: number
    /**
     * How often to report metrics.
     */
    metricSamplingInterval?: number,
    /**
     * Compile schemas in {@link filters} and {@link triggers} in debug mode. Default - false.
     */
    debugSchema?: boolean,
    /**
     * Recording mode. Default - 'immediate'
     */
    mode?: RecordMode
}

interface TracingConfig {
    /**
     * Trigger - functions accepting event and telling if the event as well as all previous and following events should be logged.
     */
    readonly triggers: {
        /**
         * Trigger function for info events.
         */
        readonly info: CompiledSchema
        /**
         * Trigger function for warn events.
         */
        readonly warn: CompiledSchema
        /**
         * Trigger function for errors.
         */
        readonly error: CompiledSchema
        /**
         * Trigger function for request data.
         */
        readonly request: CompiledSchema
    },
    /**
     * Filters - functions accepting event and telling if the event should be ignored or recorded.
     */
    readonly filters: {
        /**
         * Filter function for trace events.
         */
        readonly info: CompiledSchema
        /**
         * Filter function for metrics.
         */
        readonly warn: CompiledSchema
        /**
         * Filter function for errors.
         */
        readonly error: CompiledSchema
    },
    /**
     * Maximum number of events to record before dropping older events.
     */
    readonly maxTraceSize: number
    /**
     * Maximum interval between metric updates.
     */
    readonly metricSamplingInterval: number
}

type RecordMode = "immediate" | "accumulating"

function alwaysTrue() {
    return true
}

function alwaysFalse() {
    return false
}

type TimestampedTrace = Trace & { ts: number }

export class EventRecorder {
    private _events: TimestampedTrace[] = []
    private _mode: RecordMode

    readonly config: TracingConfig;

    /**
     * Event recording mode: immediate - report all events right away, request - report at the end of request if any
     * of the [trigger]{@link TracingOptions.triggers} fires.
     */
    get mode() {
        return this._mode
    }

    constructor(options: TracingOptions) {
        this._mode = options.mode ?? "immediate"

        function compile(s: Schema | boolean) {
            if (typeof s === "boolean") {
                return s ? alwaysTrue : alwaysFalse
            } else {
                return compileSchema(s, options.debugSchema ?? false)
            }
        }

        this.config = {
            maxTraceSize: options.maxTraceSize !== undefined ? Math.max(options.maxTraceSize, 1000) : 10000,
            metricSamplingInterval: options.metricSamplingInterval ?? 1000,
            triggers: {
                info: compile(options.triggers?.info ?? false),
                warn: compile(options.triggers?.warn ?? false),
                error: compile(options.triggers?.error ?? true),
                request: compile(options.triggers?.request ?? false)
            },
            filters: {
                info: compile(options.filters?.info ?? false),
                warn: compile(options.filters?.warn ?? false),
                error: compile(options.filters?.error ?? false),
            }
        }
    }

    /**
     * Write all pending events.
     */
    flush() {
        const {_events} = this
        for (const event of _events) {
            printEvent(event);
        }
        this._events = []
    }

    /**
     * Clear all pending requests and transition to the given record mode.
     */
    reset(mode: RecordMode) {
        if (this._mode != mode) {
            this._events = []
            this._mode = mode
        }
    }

    /**
     * Get all accumulated events.
     */
    get events(): Iterable<Readonly<Trace>> {
        const {_events} = this

        function* iterator() {
            for (const e of _events) {
                yield e as Readonly<Trace>
            }
        }

        return iterator()
    }


    /**
     * Record event if [filter]{@link TracingConfig.filters} returns true.
     * If event matches a [triggers]{@link TracingConfig.triggers}
     * @param event - diagnostic event
     */
    recordEvent(event: Trace) {
        const {_mode, config: {filters}} = this
        const evt = event as TimestampedTrace
        evt.ts = performance.now() + performance.timeOrigin
        const filter = filters[evt.level]
        if (filter(evt)) return

        if (_mode === "immediate") {
            printEvent(evt)
        } else {
            //Add event to the log
            const {_events, config: {triggers, maxTraceSize}} = this
            _events.push(evt)
            if (_events.length > maxTraceSize) {
                _events.splice(0, 100)
            }
            //Check if we should switch to immediate mode
            const trigger = triggers[evt.level]
            //If we switch, then write everything collected so far.
            if (trigger(evt)) {
                this.flush()
                this.reset("immediate")
            }
        }
    }
}

const ErrorContext = Symbol('error_context')

/**
 * Adds error context to the error and returns it
 *
 * @example produce error with context - {param, recoveryFailed:true}
 * try {
 *     someOperation(param)
 * } catch (e) {
 *     const ctx = errorContext(e, "someOperation", {param})
 *     if (!tryRecover(e)) {
 *         ctx.recoveryFailed = true
 *         throw e
 *     }
 * }
 * @param e - error
 * @param tag - error context tag
 * @param value - initial error context value
 */
export function errorContext(e: any, tag: string, value?: TraceAttributes): Record<string, Serializable> {
    const contextStack = ErrorContext in e ? e[ErrorContext] : (e[ErrorContext] = [])
    const item = {tag: tag, ...value}
    contextStack.push(item)
    return item
}

/**
 * Adds context to the error and then returns it.
 * @example
 * try {
 *     someOperation(param)
 * } catch (e) {
 *     throw withErrorContext(e, "someOperation", param)
 * }
 * @param e - error
 * @param name - error context name
 * @param value - error context value
 */
export function errorWithContext(e: any, name: string, value?: TraceAttributes): any
/**
 * Adds context to the error and then returns it.
 * @example - mapping internal error into app specific errors while reusing context information.
 * const context = { name: "MyOperation", value: { param1: 1, param2: "username" } }
 * try {
 *     someOperation(param)
 * } catch (e: any) {
 *     id (e instanceof X) { throw withErrorContext(new ErrorX(), context) }
 *     id (e instanceof Y) { throw withErrorContext(new ErrorY(), context) }
 *     throw withErrorContext(e, context)
 * }
 * @param e - error
 * @param context - error context
 * @param value - additional error context, merged with {@link context.value}.
 */
export function errorWithContext(e: any, context: ErrorContext, value?: TraceAttributes): any

export function errorWithContext(e: any, context: ErrorContext | string, value?: TraceAttributes): any {
    if (typeof context === 'string') {
        errorContext(e, context, value)
    } else {
        errorContext(e, context.name, {...context.value, ...value})
    }
    return e
}

/**
 * Find most recently added error context with a given tag
 * @param e - error
 * @param tag - context tag
 */
export function findErrorContext(e: any, tag: string): Record<string, Serializable> | undefined {
    const contextStack = ErrorContext in e ? e[ErrorContext] : (e[ErrorContext] = [])
    for (let i = 0; i < contextStack.length; ++i) {
        const errorContext = contextStack[i];
        if (errorContext.tag === tag) return errorContext
    }
    return undefined
}

/**
 * Get all error context optionally filtered by tag.
 * @param e - error
 * @param tag - error context tag
 */
export function* getErrorContexts(e: any, tag?: string): Iterable<Record<string, Serializable>> {
    const contextStack = ErrorContext in e ? e[ErrorContext] : (e[ErrorContext] = [])
    for (let i = 0; i < contextStack.length; ++i) {
        const errorContext = contextStack[i];
        if (tag === undefined || errorContext.tag === tag) yield errorContext
    }
}


/**
 * # Tracing
 * Tracer provides methods to trace program execution. Depending on configuration traces may be ignored, logged immediately or
 * logged only of an important event happens (such as an error or a timeout).
 *
 * Usually tracers write to CloudWatch during function init and switched to accumulating mode with a call to {@link startSession}
 * in the beginning of each request. Whenever tracer writes or accumulates depends on the {@link mode} property. By
 * default, tracers operate in the 'immediate' mode unless {@link configure} called with `immediateMode:true`. Call to
 * {@link startSession} switches all tracers running after the call into 'accumulating' mode. In this mode tracers write
 * logs to CloudWatch only if an event fires a trigger provided in {@link TracingOptions.triggers}. Default configuration
 * triggers on any error.
 *
 * Traces sent to AWS CloudWatch in JSON format producing records like:
 * <pre>
 *     {
 *      "timestamp":"2024-02-23T01:14:47.359Z",
 *      "level":"INFO",
 *      "requestId":"d0b8c338-0f04-490f-b0c0-67e3732e0e89",
 *      "message":{
 *          "@m":"tokens",
 *          "@t":"my-module:my-function:step-in-a-function",
 *          ... context variables recorded by the app
 *       }
 *     }
 * </pre>
 *
 * <ul>
 *     <li>timestamp - time when a trace event was pushed into CloudWatch agent. If the even were recorded before being pushed then it will have additional @ts attribute in the message.</li>
 *     <li>level - can be DEBUG, INFO or ERROR.</li>
 *     <li>requestId - AWS Lambda function request id</li>
 *     <li>message - JSON object produced by this diagnostics library</li>
 * </ul>
 *
 * # Troubleshooting `startSession` and function timeouts
 *
 * 1. Make sure function does not run out of memory. Check CloudWatch logs, if it reports timeout and also
 * `maxMemoryUsedMB` equal to `memorySizeMB` then your function run out of memory. When this happens runtime terminates
 * without leaving a chance to write any logs. To get logs before OOM enable immediate mode with
 * `configure({triggers:{request:true}})`. If you still don't see logs then function didn't produced any traces.
 * 2. Wait 5 minutes until runtime terminates. `startSession` subscribes to SIGTERM, if it happens in the session
 * scope then it logs everything accumulated till the timeout. To receive SIGTERM on runtime termination your function
 * should register an internal Lambda extension. Lambda writes log like `{"time":"2024-03-06T00:19:48.681Z","type":"platform.extension","record":{"name":"NodeJS_SIGTERM","state":"Ready","events":[]}}`
 * when it registers an internal extension.
 *
 * @example - basic tracing setup, log events on error
 * import {Tracer} from 'diagnostics'
 *
 * //Best practice: setup trigger to dump logs on important events. `error: true` is default.
 * configure({ triggers: { error: true } })
 *
 * const apiTracer = new Tracer("api")
 * //Best practice: record API and library initialization, this will be sent to CloudWatch immediately.
 * apiTracer.info("API init", {env:process.env})
 *
 * export async function myRequestHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
 *     //Best practice: make sure tracer session disposed at the end of the event, note use of 'using' statement.
 *     using tracer = apiTracer.startSession("myRequest", event)
 *     try {
 *      return await doSomething(event)
 *     } catch (e) {
 *         //Best practice: Let errors bubble, record error event at the top.
 *         tracer.error(e)
 *         throw e
 *     }
 * }
 *
 * //In the library
 * const tracer = new Tracer("library")
 * function doSomething() {
 *     tracer.info("doSomething started")
 *     try {
 *      await myImportantOperation(event)
 *     } catch (e) {
 *      //Best practice: don't record errors in service and library code, add context and throw instead.
 *      throw tracer.addContext(e, {event, operation:"myImportantOperation"})
 *     }
 * }
 */
export class Tracer {
    /**
     * Tracer tag
     */
    readonly tag: string

    /**
     * Create new tracer with a given tag.
     * @param tag - tracer tag, logged as '@t'
     */
    constructor(tag: string) {
        this.tag = tag
    }

    /**
     * Tracer recording mode.
     */
    get mode(): RecordMode {
        return eventRecorder().mode
    }

    /**
     * Create new tracer with a given scope. See {@link info}, {@link warn} and {@link error} for more details.
     * @param tag - a scope tag
     * @example
     * const root = new Tracer("myLibrary")
     * function myOpHandler() {
     *  const tracer = root.withScope("myOp")
     *  tracer.trace("step1") //emit event with tag:myLibrary.myOp
     * }
     */
    withScope(tag: string): Tracer {
        return new Tracer(`${this.tag}.${tag}`)
    }

    /**
     * Create a tracing sessions. Session evaluates {@param event} and {@param context} against
     * {@link TracingOptions.triggers.request} to decide if the session should start in 'immediate' mode.
     *
     * See {@link Tracer} for examples and details.
     *
     * @param tag - tracer session tag
     * @param event - AWS lambda event
     * @param context - AWS Lambda context
     * @param options - override default options
     */
    startSession(tag: string, event: any, context?: Context, options?: TracingOptions): TracingSession {
        return new TracingSession(`${this.tag}.${tag}`, event, context, options)
    }

    /**
     * Appends context variables to the error under {@link tag} and return the error.
     * @param error - error
     * @param context - error context to add
     * @return error provided to the function
     * @example
     * const trace = new Tracer("myOperation")
     * try {
     *     myOperation(param)
     * } catch (e:any) {
     *     throw trace.addContext(e, {param})
     * }
     */
    errorWithContext(error: any, context?: TraceAttributes): ReturnType<typeof errorWithContext> {
        return errorWithContext(error, this.tag, context)
    }

    /**
     * Create new error context under {@link tag} and optionally append provided variables to it.
     * @param error - error
     * @param initialValue - error context
     * @return error context
     */
    createErrorContext(error: any, initialValue?: TraceAttributes): ReturnType<typeof errorContext> {
        return errorContext(error, this.tag, initialValue)
    }

    /**
     * Record a trace event.
     * @param message - trace message
     * @param attributes - trace event attributes
     */
    info(message: string, attributes: TraceAttributes = {}): void {
        this.recordEvent({tag: this.tag, level: 'info', message: message, attributes})
    }

    /**
     * Record a warning event.
     * @param message - warn message
     * @param attributes - warn event attributes
     */
    warn(message: string, attributes: TraceAttributes = {}): void {
        this.recordEvent({tag: this.tag, level: 'warn', message: message, attributes})
    }

    /**
     * Record an error message.
     * @param error - error message
     * @param attributes - error attributes
     */
    error(error: string, attributes?: TraceAttributes): void
    /**
     * Record an error.
     * @param error - error object.
     * @param attributes - error attributes
     */
    error(error: Error, attributes?: TraceAttributes): void
    /**
     * Record an error.
     * @param error - error object or message.
     * @param attributes - error attributes
     */
    error(error: any, attributes?: TraceAttributes): void
    /**
     * Record an error.
     * @param error - error message or error object
     * @param attributes - error attributes
     */
    error(error: any, attributes: TraceAttributes = {}): void {
        if (typeof error === "string") {
            this.recordEvent({tag: this.tag, level: 'error', message: error, attributes})
        } else if (error instanceof Error) {
            errorContext(error, this.tag, attributes)
            this.recordEvent({
                tag: this.tag,
                level: 'error',
                message: error.message,
                error,
                attributes: (error as any)[ErrorContext]?.toReversed()
            })
        } else {
            this.recordEvent({tag: this.tag, level: 'error', message: JSON.stringify(error), attributes})
        }
    }

    /**
     * Cached events, empty if {@link mode} is "immediate".
     */
    get events(): Iterable<Readonly<Trace>> {
        return eventRecorder().events
    }

    private recordEvent(event: Trace) {
        eventRecorder().recordEvent(event)
    }
}

class TracingSession extends Tracer {
    private readonly flushEvents: () => void;

    constructor(tag: string, event: any, context?: Context, options?: TracingOptions) {
        super(tag);
        if (RecorderStore.getStore() !== undefined)
            throw new Error("Cannot start session when another session is in progress")
        const sessionRecorder = new EventRecorder(options ?? DefaultOptions)
        const isImmediate = sessionRecorder.config.triggers.request({event, context});
        sessionRecorder.reset(isImmediate ? "immediate" : "accumulating")
        RecorderStore.enterWith(sessionRecorder)
        this.flushEvents = function () {
            sessionRecorder.flush()
        }
        process.on('SIGTERM', this.flushEvents)
    }

    done() {
        RecorderStore.disable()
        process.off('SIGTERM', this.flushEvents)
    }

    [Symbol.dispose]() {
        this.done()
    }
}

/**
 * Configure tracing
 * @param options - tracing options
 */
export function configure(options: TracingOptions) {
    DefaultRecorder?.flush()
    DefaultOptions = options;
    DefaultRecorder = new EventRecorder(DefaultOptions)
}

function printEvent(event: TimestampedTrace) {
    if (event.error !== undefined) {
        console.error({
            '@t': event.tag,
            '@m': event.message,
            '@ts': event.ts,
            errorType: event.error.name,
            errorMessage: event.error.message,
            stackTrace: event.error.stack.split('\n'),
            errorContext: event.attributes,
        })
    } else {
        const fn = logFunction(event.level)
        fn({
            '@t': event.tag,
            '@m': event.message,
            '@ts': event.ts,
            ...event.attributes
        })
    }
}

/**
 * Select a log function to use. Note that AWS Lambda ignore logs produced by console.trace and console.debug and lowest
 * log level console can generate is INFO.
 * @param level
 */
function logFunction(level: TraceLevel) {
    switch (level) {
        case "info":
            return console.log
        case "warn":
            return console.warn
        case "error":
            return console.error
    }
}

/**
 * Get event recorder.
 */
function eventRecorder(): EventRecorder {
    return RecorderStore.getStore() ?? DefaultRecorder
}

let DefaultOptions: TracingOptions
let DefaultRecorder: EventRecorder
const RecorderStore = new AsyncLocalStorage<EventRecorder>()
configure({})
const EMFTracer = new Tracer("EMF")
