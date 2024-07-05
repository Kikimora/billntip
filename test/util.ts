import upath from "upath";
import fs from "fs";
import {IsEqual, Merge} from "type-fest";
import _ from "lodash";
import {Handler, HttpMethod, LambdaRequest} from "@app/lambda";
import {Context} from "aws-lambda";

export function resources() {
    const o = upath.join(__dirname, "..", "out", `resources.${process.env.TEST_STACK}.json`)
    return JSON.parse(fs.readFileSync(o).toString("utf-8"))
}

export function StaticAssert<T1, T2>() {
    return {
        is() {
        },
    } as { is(x: IsEqual<T1, T2>): void }
}

interface RequestOptions {
    routeKey: string,
    method: HttpMethod
    headers?: Record<string, string>
    cookies?: Record<string, string>
    path?: Record<string, string>
    query?: Record<string, string>
    body?: any
    authorizer?: any
}

export interface TestHandler {
    (options: Partial<RequestOptions>): Promise<any>
}

/**
 * Bind API GW Lambda handler to default parameters. Defaults loosely follow API GW payload structure while also being easy to define in a source code.
 * @param handler - API GW handler
 * @param defaults - default parameters (or a function producing parameters) to pass to the handler.
 * @example
 * const userFixture = prepareFixture('All', async function () { ... } )
 * const registration = makeTestHandler(handler, function () {
 *     const {username} = userFixture()
 *     return {
 *         method: "POST",
 *         routeKey: "POST /api/endpoint",
 *         authorizer: {lambda: cognito.newSession(username)}
 *     }
 * })
 */
export function makeTestHandler<T extends Handler>(handler: T, defaults?: RequestOptions | (() => RequestOptions)): TestHandler {
    return function (options: Partial<RequestOptions>) {
        const defaultValues = typeof defaults === 'function' ? defaults() : defaults
        options = _.defaults({}, options, defaultValues)
        const context = {functionName: "Test", functionVersion: "Test"};
        const now = new Date()
        const rawPath = Object.entries(options.path ?? []).reduce(function (path, [key, value]) {
            return path.replace(`{${key}}`, value)
        }, options.routeKey ?? "")
        const cookies = Object.entries(options.cookies ?? {}).map(([k, v]) => `${k}=${v}`)
        const rawQueryString = Object.entries(options.query ?? {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
        const event: LambdaRequest = {
            version: "2.0",
            isBase64Encoded: false,
            routeKey: options.routeKey ?? "",
            rawPath,
            pathParameters: options.path,
            cookies: cookies.length > 0 ? cookies : undefined,
            headers: options.headers ?? {},
            queryStringParameters: options.query,
            rawQueryString,
            body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
            requestContext: {

                authorizer: options.authorizer,

                accountId: "123",
                apiId: "345",
                authentication: {
                    clientCert: undefined
                },
                domainName: "test",
                domainPrefix: "",
                http: {
                    method: options.method,
                    path: rawPath,
                    protocol: "https",
                    sourceIp: "127.0.0.1",
                    userAgent: "Test Browser"
                },
                requestId: "TEST REQUEST",
                routeKey: options.routeKey,
                stage: "TEST",
                time: now.toString(),
                timeEpoch: now.getTime() / 1000

            } as any,
        }
        return handler(event, context as any)
    }
}

export class RequestBuilder {

    constructor(context: Partial<Context>) {
        this.context = context
    }

    public readonly event: any = {}
    public readonly context: any = {}

    run<T extends Handler>(handler: T) {
        return handler(this.event, this.context)
    }

    build() {
        return [this.event, this.context]
    }

    route(key: string, params?: Record<string, string>) {
        _.merge(this.event, {
            routeKey: key,
            pathParameters: params
        })
        return this
    }

    lambdaAuth(lambda: object) {
        _.merge(this.event, {
            requestContext: {
                authorizer: {
                    lambda
                }
            }
        })
        return this
    }

    jsonBody(body: any) {
        _.merge(this.event, {
            body: JSON.stringify(body),
            headers: {
                'content-type': 'application/json'
            }
        })
        return this
    }
}

/**
 * Test hooks runbning before and after tests.
 */
interface Hooks<T> {
    /**
     * Hook running before test
     */
    before?(): Promise<T> | T

    /**
     * Hook running after test
     * @param fixture - fixture created in before hook
     */
    after?(fixture: T): Promise<void> | void
}

/**
 * Returns true if given instance is an instnace of {@link Hooks}
 * @param x - instance to check
 */
function isHooks(x: any): x is Hooks<any> {
    if (typeof x !== 'object') return false
    const {before, after} = x
    if (before !== undefined && typeof before !== 'function') return false
    if (after !== undefined && typeof after !== 'function') return false
    return before !== undefined || after !== undefined

}

/**
 * A function providing test data.
 */
type TestDataProvider<T> = () => T

/**
 * Different ways of producing a test data (and optionally cleaning up after the test).
 */
type Fixture<T> = Hooks<T> | Promise<T> | (() => Promise<T>) | (() => T)

/**
 * A helper function to help TS infer correct `before` and `after` types.
 * @param hooks
 * @example
 * makeFixture({
 *     before() {
 *         return {a:1, b:2}
 *     },
 *     after({a, b}) {
 *         console.log("Without `makeFixture` TS cannot infer `after` parameter type.")
 *     }
 * })
 */
export function makeFixture<T>(hooks: Hooks<T>): Fixture<T> {
    return hooks
}

/**
 * Prepare test data
 * @param scope - when to run, either before all or before each test
 * @param producer - test data producer
 * @returns function returning test data
 * @example
 * import {cognito, prepareFixture, makeTestHandler} from "@app/tests"
 * import {__init, handler} from "./my-module"
 *
 * const userFixture = prepareFixture('All', async function () { ... } )
 *
 * const invite = makeTestHandler(handler, function () {
 *     const {username} = userFixture()
 *     return {
 *         method: "POST",
 *         routeKey: "POST /users/invite",
 *         authorizer: {lambda: cognito.newSession(username)}
 *     }
 * })
 *
 * it("can invite members", async function () {
 *     const {invitee} = userFixture()
 *     expect(await invite({body:{ invitee }})).toEqual({})
 * })
 */
export function prepare<T>(scope: 'Once' | 'Each', producer: Fixture<T>): TestDataProvider<T> {
    let data!: T

    if (producer instanceof Promise) {
        const promise = producer
        producer = () => promise
    }

    if (typeof producer === 'function') {
        const before = producer
        producer = {before}
    }

    if (!isHooks(producer)) {
        const record = producer
        producer = {
            async before() {
                const keys = Object.keys(record)
                const promises = Object.values(record)
                const values = await Promise.all(promises)
                return keys.reduce(function (acc, x, i) {
                    acc[x] = values[i]
                    return acc
                }, {} as any)
            }
        }
    }

    const {before, after} = producer

    if (before !== undefined) {
        const jestBefore = scope === 'Once' ? beforeAll : beforeEach
        jestBefore(async function () {
            const x = before()
            if (x instanceof Promise) {
                data = await x
            } else {
                data = x
            }
        })
    }

    if (after !== undefined) {
        const jestAfter = scope === 'Once' ? afterAll : afterEach
        jestAfter(function () {
            return after(data)
        })
    }

    return function () {
        return data
    }
}

/**
 * Merge two {@link TestDataProvider} into one
 * @param x - a test fixture
 * @param y - a test fixture
 * @returns test fixture providing both x and y data
 */
export function merge<X, Y>(x: TestDataProvider<X>, y: TestDataProvider<Y>): TestDataProvider<Merge<X, Y>> {
    return function () {
        return {...x(), ...y()}
    }
}
