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
                throw tracer.errorWithContext(e, {options, iterations, now, deadline})
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
            throw tracer.errorWithContext(e, {options, iterations, deadline, now, lastError})
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

export function die(errorMessage: Error): never
export function die(errorMessage: string, E?: { new(m: string): Error; }): never
export function die(error: string | Error, E?: { new(m: string): Error; }): never {
    if (typeof error === "string")
        throw new (E ?? Error)(error);
    throw error
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
            throw new Error('Unexpected token units ' + units)
    }
}

export function cyrb53(str: string, seed: number = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

interface OnlyLeft<T> {
    type: 'left'
    left: T
}

interface OnlyRight<T> {
    type: 'right'
    right: T
}

interface Both<L, R> {
    type: 'both'
    left: L
    right: R
}

export type MergePair<L, R = L> = OnlyLeft<L> | OnlyRight<R> | Both<L, R>

export function mergeJoin<L, R = L>(left: Readonly<L[]>,
                                    right: Readonly<R[]>,
                                    cmp: (x: L, y: R) => number): Generator<MergePair<L, R>>
export function mergeJoin<L, R = L>(left: Iterable<L>,
                                    right: Iterable<R>,
                                    cmp: (x: L, y: R) => number): Generator<MergePair<L, R>>
export function* mergeJoin<L, R = L>(left: any,
                                     right: any,
                                     cmp: (x: L, y: R) => number): Generator<MergePair<L, R>> {
    const leftI = left[Symbol.iterator]()
    const rightI = right[Symbol.iterator]()
    let l = leftI.next()
    let r = rightI.next()
    while (!l.done && !r.done) {
        const c = cmp(l.value, r.value)
        if (c < 0) {
            yield {type: 'left', left: l.value}
            l = leftI.next()
        } else if (c == 0) {
            yield {type: 'both', left: l.value, right: r.value}
            l = leftI.next()
            r = rightI.next()
        } else {
            yield {type: 'right', right: r.value}
            r = rightI.next()
        }
    }
    while (!l.done) {
        yield {type: 'left', left: l.value}
        l = leftI.next()
    }
    while (!r.done) {
        yield {type: 'right', right: r.value}
        r = rightI.next()
    }
}

export function mapKeysDeep<T>(value: T, rename: (name: string) => string): T {
    if (Array.isArray(value)) {
        return value.map(function (item) {
            return mapKeysDeep(item, rename)
        }) as any
    } else if (typeof value === "object" && value !== null) {
        const item: any = {}
        const val: any = value
        for (const prop of Object.keys(val)) {
            const newKey = rename(prop)
            item[newKey] = mapKeysDeep(val[prop], rename)
        }
        return item
    } else {
        return value
    }
}

export function toCamel(o: any) {
    const rename = (origKey: string) => (origKey.charAt(0).toLowerCase() + origKey.slice(1) || origKey).toString()
    if (typeof o === 'string') return rename(o)
    return mapKeysDeep(o, rename)
}

export function toPascal(o: any) {
    const rename = (origKey: string) => (origKey.charAt(0).toUpperCase() + origKey.slice(1) || origKey).toString()
    if (typeof o === 'string') return rename(o)
    return mapKeysDeep(o, rename)
}

export function cache<T>(ttl: number, producer: () => Promise<T>) {
    let expiry = -1
    let value: Promise<T>
    let producers = 0

    return function (force?: boolean) {
        force = force ?? false
        const isProducing = producers > 0
        const cacheExpired = expiry - performance.now() <= 0;
        if ((cacheExpired && !isProducing) || force) {
            producers++
            value = producer()
                .then(function (result) {
                    expiry = performance.now() + ttl * 1000
                    return result
                }).finally(function () {
                    producers--
                })
        }
        return value
    }
}

export function onceAsync<T extends (...args: any[]) => Promise<any>>(producer: T, ...args: Parameters<T>): () => Promise<ReturnType<T>> {
    let value: Promise<ReturnType<T>>
    let hasValue: boolean = false
    let isRunning: boolean = false

    return function () {
        if (!hasValue && !isRunning) {
            isRunning = true
            value = producer(...args)
                .then(function (e) {
                    hasValue = true
                    return e
                })
                .catch(function (e) {
                    hasValue = false
                    throw e
                })
                .finally(function () {
                    isRunning = false
                })
        }

        return value
    }
}