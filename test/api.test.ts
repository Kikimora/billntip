import {Context} from "aws-lambda";
import {
    IAMAuthorizedRequest,
    JsonBodyError,
    JWTAuthorizedRequest,
    LambdaAuthorizedRequest,
    Middleware,
    pipeline,
    Request,
    RouteMap,
    TracedEvent
} from "@app/lambda";
import {Tracer} from "@app/diagnostics";
import _ from "lodash";
import {Type, TypeBoxError} from "@sinclair/typebox";
import {StaticAssert} from "./util";
import {ValueError} from "@sinclair/typebox/errors";

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
    const handler = pipeline().parseJsonBody({checkContentType: false}).done(async function (e) {
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

    it("throws SyntaxError on invalid JSON", async () => {
        request.body = "xyz"
        const faultyRequest = function () {
            return handler(request, context)
        };
        await expect(faultyRequest).rejects.toThrow(JsonBodyError)
    })

    it.each([
        ["no Content-Type header", {}],
        ["invalid Content-Type", {'content-type': 'text/xml'}],
    ])("throws if %s", async (_str, headers) => {
        request.body = "{}"
        request.headers = headers
        const handler = pipeline().parseJsonBody({checkContentType: true}).done(_.identity)
        await expect(function () {
            return handler(request, context)
        }).rejects.toThrow(JsonBodyError)
    })
})


describe("Lambda API withRoute middleware", () => {
    const UserRequest = Type.Object({
        name: Type.String({minLength: 3, maxLength: 100}),
        age: Type.Number({minimum: 0, maximum: 150})
    })
    const UserId = {id: Type.Number({minimum: 0})}
    const User = Type.Object({
        ...UserRequest.properties,
        ...UserId
    })
    const UserAPI = {
        "POST /users": {
            operationId: "CreateUser",
            body: UserRequest,
            success: User
        },
        "GET /user/{id}": {
            operationId: "GetUser",
            path: UserId,
            query: {
                name: Type.Optional(UserRequest.properties.name),
                age: Type.Optional(UserRequest.properties.age),
            },
            success: User
        },
        "PUT /user/{id}": {
            operationId: "UpdateUser",
            path: UserId,
            body: UserRequest,
            success: User
        }
    } as const satisfies RouteMap

    const handler = pipeline()
        .withRoutes(UserAPI)
        .parseJsonBody({checkContentType: false})
        .done(async function (req) {
            StaticAssert<typeof req.routeKey, "GET /user/{id}" | "POST /users" | "PUT /user/{id}">().is(true)

            switch (req.routeKey) {
                case "GET /user/{id}": {
                    const {path: {id}, query, body} = req.parse()
                    StaticAssert<typeof id, number>().is(true);
                    StaticAssert<typeof query, { readonly name?: string, readonly age?: number }>().is(true)
                    StaticAssert<typeof body, never>().is(true)
                    return {id, ...query}
                }
                case "PUT /user/{id}": {
                    const {path: {id}, query, body} = req.parse()
                    StaticAssert<typeof id, number>().is(true)
                    StaticAssert<typeof query, never>().is(true)
                    StaticAssert<typeof body, { name: string, age: number }>().is(true)
                    return {id, ...body}
                }
                case "POST /users": {
                    const {path, cookies, query, body, headers} = req.validate();
                    StaticAssert<typeof path, never>().is(true)
                    StaticAssert<typeof cookies, never>().is(true)
                    StaticAssert<typeof query, never>().is(true)
                    StaticAssert<typeof body, ValueError[]>().is(true)
                    StaticAssert<typeof headers, ValueError[]>().is(false)
                    return {path, cookies, query, body, headers};
                }
            }
        })

    it("parse request", async () => {
        request.routeKey = "PUT /user/{id}"
        request.pathParameters = {id: 12}
        request.body = JSON.stringify({name: "No Name", age: 5})
        const response = await handler(request, context)
        expect(response).toEqual({id: 12, name: "No Name", age: 5})
    })

    it.each([
        ["presence of required parameter in the path", "PUT /user/{id}", {}, {name: "NoName", age: 1}, {}],
        ["path parameter value", "PUT /user/{id}", {id: "aaa"}, {}, {}],
        ["body", "PUT /user/{id}", {id: 12}, {name: 12}, {}],
        ["query string", "GET /user/{id}", {}, {}, {name: 12}],
    ])("validates %s", async (_, routeKey, path, body, query) => {
        request.routeKey = routeKey
        request.pathParameters = path
        request.body = JSON.stringify(body)
        request.queryStringParameters = query
        await expect(async function () {
            await handler(request, context)
        }).rejects.toThrow(TypeBoxError)
    })

    it("returns 404", async () => {
        request.routeKey = "POST /pets/{id}"
        const response = await handler(request, context)
        expect(response).toEqual({statusCode: 404})
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
