import {Tracer, withErrorContext} from "./diagnostics";
import http from "./http";

export function refresh<T>(ttl: number, fn: () => Promise<T>) {
    ttl = ttl * 1000
    let start = performance.now()
    let value: T
    return async function () {
        const now = performance.now()
        if (value === undefined || now - start < ttl) {
            value = await fn()
            start = now
        }
        return value
    }
}

export function delay(timeout: number) {
    return new Promise(function (resolve) {
        setTimeout(resolve, timeout);
    });
}

/**
 * Poller options
 */
export interface PollerOptions {
    /**
     * Maximum number of iterations this poller allowed to perform.
     */
    maxIterations?: number,
    /**
     * Maximum time the poller allowed to run.
     */
    timeout?: number,
    /**
     * Delay between poller operations in milliseconds.
     */
    delay?: number | (() => number)
}

export interface Just<V, Type extends string> {
    type: Type
    value: V
}

type Maybe<T> = Just<T, "Just"> | Just<any, "Error">

export type Either<X, Y> = Just<X, "X"> | Just<Y, "Y">

export async function runOnce<T>(operation: () => Promise<T>): Promise<Maybe<T>> {
    try {
        return {value: await operation(), type: "Just"}
    } catch (error: any) {
        return {value: error, type: "Error"}
    }
}

/**
 * Retry operation several times until it either succeed, timeout or reaches maximum number of allowed attempts.
 * @param action - operation to perform
 * @param options - operation options.
 */
export async function retry<T>(action: () => Promise<T>, options: PollerOptions): Promise<T> {
    const result = await repeat<T>(async function (done) {
        done(await action())
    }, options)

    switch (result.type) {
        case "error":
            throw result.value
        case "done":
            return result.value
        case "timeout":
            const e = new Error("Unexpected error: retry operation finished without producing any result.")
            throw withErrorContext(e, "retry", {result, options})
    }
}

type PollerResult<T> = Just<T, "done"> | Just<null, "timeout"> | Just<any, "error">
type PollerFunction<T> = (done: (val: T) => void) => Promise<any>

/**
 * Run operation in a loop until it signal completion, time out or reaches maximum number of allowed attempts.
 * @param action - operation to perform
 * @param options - operation options.
 */
export async function repeat<T>(action: PollerFunction<T>, options: PollerOptions): Promise<PollerResult<T>> {
    const maxIteration = options.maxIterations ?? -1
    const timeout = options.timeout ?? -1
    const delayMs = options.delay ?? 0
    const deadline = options.timeout != null ? performance.now() + timeout : null
    let iterations = 0;
    let done = false;
    let result: T | undefined
    do {
        try {
            await action(function (r: T) {
                result = r
                done = true;
            })
            if (done) return {type: "done", value: result!};
        } catch (e: any) {
            const now = performance.now();
            e = withErrorContext(e, "repeat", {options, iterations, now, deadline})

            if (maxIteration >= 0 && iterations >= maxIteration) {
                return {type: "error", value: e}
            }
            if (deadline != null && deadline > now) {
                return {type: "error", value: e}
            }
        }

        try {
            if (maxIteration >= 0 && iterations >= maxIteration)
                return {type: "timeout", value: null}
            if (deadline != null && deadline > performance.now())
                return {type: "timeout", value: null}

            iterations++

            if (typeof delayMs == "number") {
                await delay(delayMs)
            } else {
                const timeout = delayMs();
                await delay(timeout)
            }
        } catch (e) {
            const now = performance.now();
            throw withErrorContext(e, "repeat", {options, iterations, deadline, now})
        }
    } while (true)
}

let registered = false
const tracer = new Tracer("util")

type RuntimeEvents = 'shutdown'
export const runtime = {
    on(event: RuntimeEvents, listener: (...args: any[]) => void) {
        switch (event) {
            case 'shutdown': {
                const registerUrl = process.env.AWS_LAMBDA_RUNTIME_API
                if (registerUrl && !registered) {
                    registered = true
                    // noinspection HttpUrlsUsage
                    const ExtensionApi = `http://${registerUrl}/2020-01-01/extension`
                    // AWS Lambda used to be sending only SIGKILL at the end of lifetime, or after a timeout.
                    // But if there is an internal or external extension then it sends SIGTERM and then SIGKILL.
                    // Internal extensions has 500 ms, external have 2 seconds.
                    // Below code registers internal extension and calls `next` to let Lambda kow extension is alive.
                    http.post(`${ExtensionApi}/register`, {events: []}, {
                        headers: {
                            "Lambda-Extension-Name": "NodeJSEnableSIGTERM"
                        }
                    }).then(function (res) {
                        const id = res.headers['Lambda-Extension-Identifier']
                        if (!id) {
                            console.error("Cannot register extension to enable SIGTERM handler.")
                            return
                        }
                        //Let Lambda know extension is alive.
                        return http.post(`${ExtensionApi}/next`, {}, {
                            headers: {
                                'Lambda-Extension-Identifier': id
                            }
                        })
                    }).catch(e => {
                        tracer.error(e)
                    })
                }
                //Register SIGTERM handler.
                process.on('SIGTERM', listener)
                process.on('SIGINT', listener)
                break;
            }
            default: {
                tracer.warn("adding listener to an unknown event", {event})
            }
        }


    },
    off(event: RuntimeEvents, listener: (...args: any[]) => void) {
        switch (event) {
            case 'shutdown': {
                process.off('SIGTERM', listener)
                process.off('SIGINT', listener)
            }
                break;
            default: {
                tracer.warn("removing listener from an unknown event", {event})
            }
        }
    }
}