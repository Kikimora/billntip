import _ from "lodash"

import {Tracer} from "./diagnostics";
import {v4} from "uuid";

type TimeUnitsType = "days" | "hours" | "minutes" | "seconds"

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

//IDK why but without this pulumi fails to compile files using _.defaults
//Other lodash methods compile just fine.
declare module "lodash" {
    // noinspection JSUnusedGlobalSymbols
    interface LoDashStatic {
        defaults<TObject, TSource>(object: TObject, source: TSource): NonNullable<TSource & TObject>;

        defaults<TObject, TSource1, TSource2>(object: TObject, source1: TSource1, source2: TSource2): NonNullable<TSource2 & TSource1 & TObject>;

        defaults<TObject, TSource1, TSource2, TSource3>(object: TObject, source1: TSource1, source2: TSource2, source3: TSource3): NonNullable<TSource3 & TSource2 & TSource1 & TObject>;

        defaults<TObject, TSource1, TSource2, TSource3, TSource4>(object: TObject, source1: TSource1, source2: TSource2, source3: TSource3, source4: TSource4): NonNullable<TSource4 & TSource3 & TSource2 & TSource1 & TObject>;

        defaults<TObject>(object: TObject): NonNullable<TObject>;

        defaults(object: any, ...sources: any[]): any;
    }
}

export function die(errorMessage: string, E?: { new(m: string): Error; }): never {
    throw new (E ?? Error)(errorMessage);
}

declare module 'lodash' {
    interface LoDashStatic {
        throw(errorMessage: string, E?: { new(m: string): Error; }): never
    }
}

_.mixin({
    'throw': function (errorMessage: string, E?: { new(m: string): Error; }): never {
        throw new (E ?? Error)(errorMessage);
    }
})

export default _

export function toSeconds(value: number, units: TimeUnitsType) {
    switch (units) {
        case 'seconds':
            return value
        case 'minutes':
            return value * 60
        case 'hours':
            return value * 3600
        case 'days':
            return value * 3600 * 24
        default:
            throw new Error('Unexpected token units ' + value)
    }
}