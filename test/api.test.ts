import {Context} from "aws-lambda";
import {
    IAMAuthorizedRequest, JWTAuthorizedRequest, LambdaAuthorizedRequest,
    Middleware,
    pipeline,
    Request,
    TracedEvent
} from "@app/lambda";
import {ErrorContext, Tracer} from "@app/diagnostics";

let request!: any, context!: any
beforeEach(() => {
    request = {}
    context = {}
})

describe("Lambda API Pipeline", () => {

    it("combines multiple middlewares in a typesafe manner", async () => {
        type X = { x: string }

        async function xMiddleware(this: Middleware<X>, e: Request, ctx: Context) {
            const request = e as Request & X
            request.x = "X Middleware"
            return this.next(request, ctx)
        }

        type Y = { y: string }

        async function yMiddleware(this: Middleware<Y>, e: Request, ctx: Context) {
            const request = e as Request & Y
            request.y = "Y Middleware"
            return this.next(request, ctx)
        }

        const handler = pipeline()
            .do(xMiddleware)
            .do(yMiddleware)
            .done(async function (e) {
                return {x: e.x, y: e.y}
            })
        expect(await handler(request, context)).toEqual({
            x: "X Middleware",
            y: "Y Middleware"
        })
    })

    it("run middleware in order", async () => {

        const handler = pipeline()
            .do(function (this: Middleware<{ messages: string[] }>, e, c) {
                const request = e as Request & { messages: [] }
                request.messages = []
                return this.next(request, c)
            })
            .do(function (e, c) {
                e.messages.push("middleware 1")
                return this.next(e, c)
            })
            .do(function (e, c) {
                e.messages.push("middleware 2")
                return this.next(e, c)
            })
            .done(async function (e) {
                return {messages: e.messages}
            })

        expect(await handler(request, context)).toEqual({
            messages: ["middleware 1", "middleware 2"]
        })
    })

    it("pipeline cannot be reused", () => {
        const p = pipeline()
        const handlerFunction = async function () {
            return {}
        };
        p.done(handlerFunction)
        expect(function () {
            p.done(handlerFunction)
        }).toThrow()
    })
})

describe("Lambda API JSON Body middleware", () => {
    const handler = pipeline().parseJsonBody().done(async function (e) {
        return {
            body: e.json
        }
    })
    it("parse json", async () => {
        request.body = JSON.stringify({x: "Hello", y: "World"})
        expect(await handler(request, context)).toEqual({body: {x: "Hello", y: "World"}})
    })

    it("parse base64Encoded json", async () => {
        request.body = Buffer.from(JSON.stringify({x: "Hello", y: "World"})).toString("base64")
        request.isBase64Encoded = true
        expect(await handler(request, context)).toEqual({body: {x: "Hello", y: "World"}})
    })

    it("throws SyntaxError on invalid JSON", () => {
        request.body = "xyz"
        const faultyRequest = function () {
            return handler(request, context)
        };
        expect(faultyRequest).toThrow(expect.objectContaining({
            name: "SyntaxError",
            [ErrorContext]: [{tag: "parseJsonBody"}]
        }))
    })
})

describe("Lambda API withRoute middleware", () => {
    const handler = pipeline().withRoutes().done(async function (e) {
        return {
            body: e.routeKey
        }
    })
    it("adds route key", async () => {
        request.routeKey = "/pets/{id}"
        request.requestContext = {http: {method: "POST"}}
        expect(await handler(request, context)).toEqual({body: "POST /pets/{id}"})
    })
})

describe("Lambda API requireXYZAuth middleware", () => {
    type AuthorizedRequest = IAMAuthorizedRequest | JWTAuthorizedRequest | LambdaAuthorizedRequest
    // Typed dummyHandler won't compile if I mess up with template magic one day and pass untyped request down the
    // middleware chain.
    const dummyHandler = async function (e: AuthorizedRequest) {
        return e.requestContext.authorizer
    };

    it.each([
        ["IAM", pipeline().requireIAMAuth().done(dummyHandler), {iam: {accountId: "ACCOUNT ID"}}],
        ["JWT", pipeline().requireJWTAuth().done(dummyHandler), {
            principalId: "ACCOUNT ID",
            jwt: {claims: {"aud": "test"}}
        }],
        ["Lambda", pipeline().requireLambdaAuth().done(dummyHandler), {lambda: {x: "lambda"}}],
    ])("require %s auth", async (_, handler: any, authorizer: any) => {
        request.requestContext = {authorizer}
        expect(await handler(request, context)).toEqual({
            ...authorizer
        })
    })
})

describe("Lambda API trace request middleware", () => {

    let eventSpy!: jest.SpyInstance

    beforeEach(() => {
        request.body = "Hello World!"
        request.requestContext = {
            http: {method: "POST"},
            authorizer: {lambda: {secret: "Secret string"}}
        }
        context.functionName = "test"
        context.functionVersion = "$LATEST"
    })

    afterEach(() => {
        jest.clearAllMocks()
    })

    it("record request start and filters out authorizer details", async () => {
        const handler = pipeline().traceRequest().done(returnTracerEvents)
        const {events} = await handler(request, context)
        expect(events).toEqual(expect.objectContaining([{
            tag: "api.test.$LATEST",
            level: "info",
            message: "Started",
            ts: expect.anything(),
            attributes: {
                event: {
                    body: "Hello World!",
                    requestContext: {
                        http: {method: "POST"}
                    }
                },
                context
            }
        }]))
    })

    it("record event finish", async () => {
        const handler = pipeline().traceRequest().do(injectSpy).done(async function () {
            return {message: "Hello world"}
        })
        await handler(request, context)
        expect(eventSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            message: "Finished",
            attributes: {result: {message: "Hello world"}}
        }))
    })

    it("record errors", async () => {
        const handler = pipeline().traceRequest().do(injectSpy).done(async function () {
            throw new Error("This is a handler error")
        })
        await expect(handler(request, context)).rejects.toThrow()
        expect(eventSpy).toHaveBeenLastCalledWith(expect.objectContaining({
                tag: "api.test.$LATEST",
                level: "error",
                message: 'This is a handler error'
            }
        ))
    })

    it("can use custom tracer and tag", async () => {
        const options = {
            tracer: new Tracer("myAPI"),
            tag: function () {
                return "MyTag"
            }
        };
        const handler = pipeline().traceRequest(options).done(returnTracerEvents)
        const {events} = await handler(request, context)
        expect(events).toEqual([expect.objectContaining({
            tag: "myAPI.MyTag"
        })])
    })

    function injectSpy(this: Middleware, e: Request & TracedEvent, context: Context) {
        eventSpy = jest.spyOn(e.tracer as any, 'recordEvent')
        return this.next(e, context)
    }

    const returnTracerEvents = async function (e: Request & TracedEvent) {
        return {events: Array.from(e.tracer.events)}
    }
})
