export function loadAsync<T>(loader: () => Promise<T>) {
    let val: T
    const load = loader()
    return async function (): Promise<T> {
        if (val == null) {
            val = await load
        }
        return val
    }
}

export function requireEnv<T extends string>(props: readonly T[]): { [p in typeof props[number]]: string } {
    const missing = []
    for (const prop of props) {
        const value = process.env[prop]
        if (value == null) {
            missing.push(prop)
        }
    }
    if (missing.length > 0) {
        const message = `Some required parameters are missing: ${missing.join(', ')}`
        throw new Error(message)
    }
    return process.env as { [p in typeof props[number]]: string }
}

export function delay(timeout: number) {
    return new Promise(function (resolve) {
        setTimeout(resolve, timeout);
    });
}

export interface PollerOptions {
    maxIterations?: number,
    timeout?: number,
    delay?: number
}


interface Just<T> {
    type: "Just"
    value: T
}

interface Error {
    type: "Error"
    value: any
}

type Maybe<T> = Just<T> | Error

export async function runOnce<T>(operation: () => Promise<T>): Promise<Maybe<T>> {
    try {
        return {value: await operation(), type: "Just"}
    } catch (error: any) {
        return {value: error, type: "Error"}
    }
}

export async function retry<T>(action: () => Promise<T>, options: PollerOptions): Promise<T> {
    const maxIteration = options.maxIterations ?? -1
    const timeout = options.timeout ?? -1
    const delaySec = options.delay ?? 0
    const deadline = options.timeout != null ? Date.now() + timeout : null
    let iterations = 0;
    do {
        try {
            return await action()
        } catch (e) {
            if (maxIteration > 0 && maxIteration >= iterations++)
                throw e
            if (deadline != null && deadline > Date.now())
                throw e
        }
        await delay(delaySec)
    } while (true)
}


export class Poller {
    private iterations: number;
    private _done: boolean = false;
    private readonly deadline?: number;

    public readonly maxIteration: number
    public readonly timeout: number
    public readonly delay: number

    constructor(options: PollerOptions) {
        this.maxIteration = options.maxIterations ?? -1
        this.timeout = options.timeout ?? -1
        this.delay = options.delay ?? 0
        if (this.timeout > 0)
            this.deadline = Date.now() + this.timeout
        this.iterations = 0;
    }

    get done() {
        return this._done;
    }

    async runOnce<T>(operation: () => Promise<T>): Promise<Maybe<T>> {
        if (!await this.startNext()) {
            throw new Error(`Operation failed after reaching maximum attempts or timeout.`);
        }

        return await runOnce(operation)
    }

    async run<T>(operation: () => Promise<T>): Promise<T> {
        do {
            const {type, value} = await this.runOnce(operation)
            switch (type) {
                case "Just":
                    return value
                case "Error":
                    console.warn(`Error on attempt ${this.iterations + 1}: ${value.message}`);
            }
        } while (true)
    }

    async startNext() {
        if (this._done) return false;
        const overIterations = this.maxIteration > 0 && this.maxIteration >= this.iterations++
        const overTimeout = this.deadline != null && this.deadline > Date.now()
        if (this.delay > 0 && this.iterations > 1) {
            await delay(this.delay)
        }
        this._done = overIterations || overTimeout
        return this._done
    }

    cancel() {
        this._done = true
    }
}