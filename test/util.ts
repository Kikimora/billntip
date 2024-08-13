import upath from "upath";
import fs from "fs";
import {IsEqual, Merge} from "type-fest";
import _ from "lodash";
import {Handler, HttpMethod, LambdaRequest} from "@app/lambda";
import {
    APIGatewayRequestAuthorizerEventV2
} from "aws-lambda/trigger/api-gateway-authorizer";
import {die} from "@app/util";

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
    method?: HttpMethod
    headers?: Record<string, string>
    cookies?: Record<string, string>
    path?: Record<string, string>
    query?: Record<string, string>
}

export interface HttpRequestOptions extends RequestOptions {
    body?: any
    authorizer?: any
}

export interface TestHandler {
    (options: Partial<HttpRequestOptions>): Promise<any>
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
export function makeTestHandler<T extends Handler>(handler: T, defaults?: HttpRequestOptions | ((options: Partial<HttpRequestOptions>) => HttpRequestOptions)): TestHandler {
    return function (options: Partial<HttpRequestOptions>) {
        const defaultValues = typeof defaults === 'function' ? defaults(options) : defaults
        const requestOptions: HttpRequestOptions = {
            routeKey: options.routeKey ?? defaultValues?.routeKey ?? die("routeKey is missing"),
            headers: _.merge({}, defaultValues?.headers, options.headers),
            body: options.body ?? defaultValues?.body,
            authorizer: options.authorizer ?? defaultValues?.authorizer,
            query: _.merge({}, defaultValues?.query, options.query),
            cookies: options.cookies ?? defaultValues?.cookies,
            method: options.method ?? defaultValues?.method,
            path: options.path ?? defaultValues?.path,
        }
        const context = {functionName: "Test", functionVersion: "Test"};
        const payload = commonRequestPayload(requestOptions);
        if (requestOptions.authorizer !== undefined) {
            payload.requestContext.authorizer = requestOptions.authorizer
        }
        const event: LambdaRequest = {
            ...payload,
            isBase64Encoded: false,
            body: typeof requestOptions.body === 'string' ? requestOptions.body : JSON.stringify(requestOptions.body),
        }
        return handler(event, context as any)
    }
}

export interface AuthorizerOptions extends RequestOptions {
    identitySource?: string[]
}

export interface TestAuthorizer {
    (options: Partial<AuthorizerOptions>): Promise<any>
}

export function makeTestAuthorizer<T extends Handler>(handler: T, defaults?: AuthorizerOptions | ((options: Partial<AuthorizerOptions>) => AuthorizerOptions)): TestAuthorizer {
    return async function (options: Partial<AuthorizerOptions>) {
        const context = {functionName: "Test", functionVersion: "Test"}
        const defaultValues = typeof defaults === 'function' ? defaults(options) : defaults
        const requestOptions: AuthorizerOptions = {
            routeKey: options.routeKey ?? defaultValues?.routeKey ?? die("routeKey is missing"),
            method: options.method ?? defaultValues?.method,
            headers: _.merge({}, defaultValues?.headers, options.headers),
            cookies: options.cookies ?? defaultValues?.cookies,
            query: _.merge({}, defaultValues?.query, options.query),
            path: options.path ?? defaultValues?.path,
            identitySource: options.identitySource ?? defaultValues?.identitySource
        }
        const common = commonRequestPayload(requestOptions);
        const event: APIGatewayRequestAuthorizerEventV2 = {
            ...common,
            cookies: common.cookies ?? [],
            type: "REQUEST",
            routeArn: `arn:aws:execute-api:eu-south-1:381491945919:ddbdzsrp48/$default/${common.routeKey.replace(' ', '')}`,
            identitySource: requestOptions.identitySource ?? []
        }
        return await handler(event, context as any)
    }
}

function commonRequestPayload(options: Partial<HttpRequestOptions> | Partial<AuthorizerOptions>) {
    const now = new Date()
    const rawPath = Object.entries(options.path ?? []).reduce(function (path, [key, value]) {
        return path.replace(`{${key}}`, value)
    }, options.routeKey ?? "")
    const cookies = Object.entries(options.cookies ?? {}).map(([k, v]) => `${k}=${v}`)
    if (cookies.length > 0) {
        options.headers = options.headers ?? {}
        options.headers.cookie = cookies.join('; ')
    } else {
        delete options.headers?.cookie
    }
    const rawQueryString = Object.entries(options.query ?? {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    const routeKey = options.routeKey ?? ""
    return {
        version: "2.0",
        routeKey,
        rawPath,
        pathParameters: options.path,
        cookies: cookies.length > 0 ? cookies : undefined,
        headers: _.mapKeys(options.headers, (v, k) => k.toLowerCase()),
        queryStringParameters: options.query,
        rawQueryString,
        stageVariables: {},
        requestContext: {

            accountId: "123",
            apiId: "345",
            authentication: {
                clientCert: undefined
            },
            domainName: "test",
            domainPrefix: "",
            http: {
                method: options.method ?? routeKey.split(' ')[0],
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
}


/**
 * Test hooks running before and after tests.
 */
interface Hooks<T> {
    /**
     * Hook running before test
     */
    before(): Promise<T> | T

    /**
     * Hook running after test
     * @param fixture - fixture created in before hook
     */
    after?(fixture: T): Promise<void> | void
}

/**
 * A function providing test data.
 */
export type TestDataProvider<T> = (() => T) & { scope: 'Each' | 'Once' }

/**
 * Defines algorithm to produce test data and optionally cleanup procedure.
 */
export type Fixture<T> = Hooks<T> | (() => Promise<T>)

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

function toHooks<T>(fixture: Fixture<T>): Hooks<T>
function toHooks<T, Ctx>(fixture: ContextualFixture<T, Ctx>): ContextualHooks<T, Ctx>
function toHooks(fixture: Fixture<any> | ContextualFixture<any, any>) {
    if (typeof fixture === 'function') {
        const before = fixture
        fixture = {before}
    }
    return fixture
}

/**
 * Prepare test data
 * @param scope - when to run, either before all or before each test
 * @param fixture - test data producer
 * @returns function returning test data
 * @example
 * import {cognito, prepareFixture, makeTestHandler} from "@app/tests"
 * import {__init, handler} from "./my-module"
 *
 * const userFixture = prepareFixture('Once', async function () { ... } )
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
export function prepare<T>(scope: 'Once' | 'Each', fixture: Fixture<T>): TestDataProvider<T> {
    let data!: T
    const {before, after} = toHooks(fixture)
    if (before !== undefined) {
        const jestBefore = scope === 'Once' ? beforeAll : beforeEach
        jestBefore(async function () {
            try {
                const x = before()
                if (x instanceof Promise) {
                    data = await x
                } else {
                    data = x
                }
            } catch (e) {
                console.log("Before hook failed", e)
                throw e
            }
        })
    }

    if (after !== undefined) {
        const jestAfter = scope === 'Once' ? afterAll : afterEach
        jestAfter(async function () {
            try {
                await after(data)
            } catch (e) {
                console.log("After hook failed", e)
                throw e
            }
        })
    }

    const provider = function () {
        return data
    }
    provider.scope = scope
    return provider
}


/**
 * Hooks running withing some context provided from by the caller.
 */
interface ContextualHooks<Ctx, T> {
    /**
     * Hook running before test.
     * @param ctx - hooks context
     */
    before(ctx: Ctx): Promise<T> | T

    /**
     * Hook running after test
     * @param data - data created in the before hook merged with the context.
     */
    after?(data: Ctx & T): Promise<void> | void
}

/**
 * Contextual [fixture]{@link Fixture} constructs test data using context provided by another fixture or a data provider.
 *
 * @description Contextual fixtures is an advanced feature useful in scenarios where:
 * 1. there is a reusable piece of setup,
 * 2. that depends on some other piece of test data,
 * 3. which in turn sometimes created for each test and sometimes just once.
 *
 * Contextual fixture defines dependency and let user provide it once they are available.
 *
 * @example
 *
 * const slowFixture = async function () {
 *     return await someVerySlowSetup()
 * }
 * describe("has to run slow fixture for every test", () =>{
 *     const slowEachTime = prepare('Each', slowFixture)
 *     it("slow test", async ()=>{
 *         const {username, repo} = slowEachTime()
 *         expect(repo.create(username)).resolve.toMatchObject({username})
 *     })
 * })
 *
 * const dependsOnSlowButFastOtherwise = makeContextualFixture(slowFixture, async function ({user}) {
 *     return {
 *         age: user.age + 1
 *     }
 * })
 * describe("needs slow fixture only once", () =>{
 *     const slow = prepare('Once', createUserFixture)
 *     const fast = prepareWithContext('Each', slow, dependsOnSlowButFastOtherwise)
 *     it("runs slow only once", async () {
 *         const {age} = fast()
 *         await user.update({email:'new@mail.com'})
 *         expect(age).toBe(30)
 *     })
 * })
 *
 * const chain = chainFixtures(slowFixture, dependsOnSlowButFastOtherwise)
 * describe("needs both slow and fast only once", ()=>{
 *     const testData = prepare('Once', chain)
 *     it("use test data", () =>{
 *         const {user} = testData()
 *     })
 * })
 */
type ContextualFixture<Ctx, T> = ContextualHooks<Ctx, T> | ((ctx: Ctx) => Promise<T>) | ((ctx: Ctx) => T)

/**
 * Combines two fixtures into one running first fixture and then the second fixture. Second fixture receives first
 * fixture results as a parameter.
 * @param x - first fixture
 * @param y - second fixture
 *
 * @example - reuse fixtures by chaining them
 *
 * const freshUserFixture = async function () {
 *     return { username: uuid.v4(), repo: new UserRepo() }
 * }
 * describe("create", () =>{
 *     const freshUser = prepare('Each', freshUserFixture)
 *     it("creates user", async ()=>{
 *         const {username, repo} = freshUser()
 *         expect(repo.create(username)).resolve.toMatchObject({username})
 *     })
 * })
 * const createUserFixture = chainFixtures(freshUserFixture, async function ({username, repo}) {
 *     return {
 *         user: await repo.createUser(username)
 *     }
 * })
 * describe("update", () =>{
 *     const createUser = prepare('Each', createUserFixture)
 *     it("updates user", async () {
 *         const {user} = createUser()
 *         await user.update({email:'new@mail.com'})
 *         expect(user.email).toBe('new@mail.com')
 *     })
 * })
 *
 */
export function chainFixtures<X, Y>(x: Fixture<X>, y: ContextualFixture<X, Y>): Hooks<X & Y>
export function chainFixtures<X, Y, Z>(x: Fixture<X>, y: ContextualFixture<X, Y>, z: ContextualFixture<X & Y, Z>): Hooks<X & Y & Z>
export function chainFixtures<A, B, C, D>(a: Fixture<A>, b: ContextualFixture<A, B>, c: ContextualFixture<A & B, C>, d: ContextualFixture<A & B & C, D>): Hooks<A & B & C & D>
export function chainFixtures(x: Fixture<any>, ...y: ContextualFixture<any, any>[]): Hooks<any> {

    function combine(x: Hooks<any>, y: ContextualFixture<any, any>) {
        const {before: xBefore, after: xAfter} = toHooks(x)
        const {before: yBefore, after: yAfter} = toHooks(y)

        return {
            async before() {
                const xx = await xBefore()
                const yy = await yBefore(xx)
                return {...xx, ...yy}
            },
            async after(x: any) {
                if (yAfter !== undefined) await yAfter(x)
                if (xAfter !== undefined) await xAfter(x)
            }
        }
    }

    return y.reduce(combine, toHooks(x))
}

/**
 * Type inference helper to define fixture which can be instantiated on the context of another fixture. See details [here]{@link ContextualFixture}.
 * @param _ctxFixture - fixture providing context
 * @param fixture - fixture
 */
export function makeContextualFixture<Ctx, T>(_ctxFixture: Fixture<Ctx>, fixture: ContextualFixture<Ctx, T>): ContextualFixture<Ctx, T>
export function makeContextualFixture<Ctx, X, Y>(_ctxFixture: ContextualFixture<Ctx, X>, fixture: ContextualFixture<Ctx & X, Y>): ContextualFixture<Ctx & X, Y>
export function makeContextualFixture(_ctxFixture: any, fixture: any) {
    return fixture
}

/**
 * Create data provider for a contextual fixture.
 * @param scope - fixture scope
 * @param ctxProvider - context data provider
 * @param fixture - fixture
 */
export function prepareWithContext<T, Ctx>(scope: 'Once' | 'Each', ctxProvider: TestDataProvider<Ctx>, fixture: ContextualFixture<Ctx, T>): TestDataProvider<Ctx & T> {
    if (commonScope(ctxProvider.scope, scope) !== scope) {
        throw new Error("Cannot build 'Once' data provider using context provider with 'Each' scope")
    }
    const {before, after} = toHooks(fixture)
    return prepare(scope, {
        async before() {
            const ctx = ctxProvider()
            const x = await before(ctx)
            return {...ctx, ...x}
        },
        async after(x) {
            if (after !== undefined) {
                await after(x)
            }
        }
    })
}

/**
 * Merge two {@link TestDataProvider} into one
 * @param x - a test fixture
 * @param y - a test fixture
 * @returns test fixture providing both x and y data
 */
export function merge<X, Y>(x: TestDataProvider<X>, y: TestDataProvider<Y>): TestDataProvider<Merge<X, Y>> {
    const provider = function () {
        return {...x(), ...y()}
    }
    provider.scope = commonScope(x.scope, y.scope)
    return provider
}

function commonScope(x: 'Once' | 'Each', y: 'Once' | 'Each') {
    if (x === y) return x
    return 'Each'
}

export interface MockResult<T> {
    value?: T
    error?: any
}

export async function clearMock<T, Y extends any[]>(spy: jest.SpyInstance<T, Y>, processor: (result: MockResult<Awaited<T>>, ...args: any[]) => Promise<void>) {
    const {mock: {results, calls, instances}} = spy
    const len = Math.min(results.length, calls.length)

    function runProcessor(instance: any, result: MockResult<Awaited<T>>, args: any[]) {
        return processor.call(instance, ...[result, ...args])
    }

    try {
        for (let i = 0; i < len; ++i) {
            const args = calls[i]
            const result = results[i]
            const instance = instances[i]
            if (result.type === 'return') {
                if (result.value instanceof Promise) {
                    await result.value
                        .then(value => runProcessor(instance, {value}, args))
                        .catch(error => runProcessor(instance, {error}, args))
                } else {
                    //result.value is not a promise but still await it to please compiler.
                    await runProcessor(instance, {value: await result.value}, args)
                }
            } else if (result.type === 'throw') {
                await runProcessor(instance, {error: result.value}, args)
            } else {
                await runProcessor(instance, {}, args)
            }
        }
    } finally {
        spy.mockClear()
    }
}