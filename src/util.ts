import {Tracer} from "./diagnostics";
import {v4} from "uuid";

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
    /**
     * Poller operation name.
     */
    name?: string
}

export interface Just<V, Type extends string> {
    type: Type
    value: V
}

/**
 * Retry operation several times until it either succeed, timeout or reaches maximum number of allowed attempts.
 * @param action - operation to perform
 * @param options - operation options.
 */
export async function retry<T>(action: () => Promise<T>, options: PollerOptions): Promise<T> {
    let result!: T
    await repeat(async function (done) {
        result = await action();
        done()
    }, options)
    return result;
}

type PollerFunction = (done: () => void) => Promise<any>

/**
 * Run operation in a loop until it signal completion, time out or reaches maximum number of allowed attempts.
 * @param action - operation to perform
 * @param options - operation options.
 */
export async function repeat(action: PollerFunction, options: PollerOptions): Promise<void> {
    const name = options.name ?? (options.name = v4())
    const tracer = utilTracer.withScope(`repeat.${name}`)
    const maxIteration = options.maxIterations ?? -1
    const timeout = options.timeout ?? -1
    const delayMs = options.delay ?? 0
    const deadline = options.timeout != null ? performance.now() + timeout : null
    let iterations = 0;
    let done = false;
    let lastError: Error | undefined
    do {
        try {
            await action(function () {
                done = true;
            })
            if (done) return
        } catch (e: any) {
            lastError = e
            const now = performance.now();
            if (maxIteration >= 0 && iterations >= maxIteration ||
                deadline != null && deadline > now) {
                throw tracer.addContext(e, {options, iterations, now, deadline})
            }
        }

        try {
            iterations++
            if (typeof delayMs == "number") {
                await delay(delayMs)
            } else {
                const timeout = delayMs();
                await delay(timeout)
            }
        } catch (e) {
            const now = performance.now();
            throw tracer.addContext(e, {options, iterations, deadline, now, lastError})
        }
    } while (true)
}

const utilTracer = new Tracer("util")
