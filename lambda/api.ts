import {Context} from "aws-lambda";
import * as lambda from "aws-lambda";
import {Tracer, withErrorContext} from "@app/diagnostics";

/**
 * AWS Lambda API gateway v2 request (aka API Gateway event).
 */
export interface Request<TAuthorizer = unknown> {
    version: string;
    routeKey: string;
    rawPath: string;
    rawQueryString: string;
    cookies?: string[];
    headers: lambda.APIGatewayProxyEventHeaders;
    queryStringParameters?: lambda.APIGatewayProxyEventQueryStringParameters;
    requestContext: lambda.APIGatewayEventRequestContextV2 & { authorizer: TAuthorizer };
    body?: string;
    pathParameters?: lambda.APIGatewayProxyEventPathParameters;
    isBase64Encoded: boolean;
    stageVariables?: lambda.APIGatewayProxyEventStageVariables;
}

type IAM = lambda.APIGatewayEventRequestContextIAMAuthorizer
/**
 * API Gateway v2 IAM authorized request.
 */
export type IAMAuthorizedRequest = Request<IAM>

/**
 * Type assert for {@link IAMAuthorizedRequest}
 * @param r - request
 */
export function isIAMAuthorizedRequest(r: Request<any>): r is IAMAuthorizedRequest {
    return 'iam' in r.requestContext.authorizer;
}

/**
 * API Gateway v2 JWT authorized request.
 */
type JWT = lambda.APIGatewayEventRequestContextJWTAuthorizer
export type JWTAuthorizedRequest = Request<JWT>

/**
 * Type assert for {@link JWTAuthorizedRequest}
 * @param r - request
 */
export function isJWTAuthorizedRequest(r: Request<any>): r is JWTAuthorizedRequest {
    return 'jwt' in r.requestContext.authorizer;
}

/**
 * API Gateway v2 Lambda (aka custom) authorized request.
 */
type LambdaAuth<T> = lambda.APIGatewayEventRequestContextLambdaAuthorizer<T>
export type LambdaAuthorizedRequest<T = unknown> = Request<LambdaAuth<T>>

/**
 * Type assert for {@link LambdaAuthorizedRequest}
 * @param r - request
 */
export function isLambdaAuthorizedRequest<T = unknown>(r: Request): r is LambdaAuthorizedRequest<T> {
    if (typeof r.requestContext.authorizer !== "object" || r.requestContext.authorizer == null) return false
    return 'lambda' in r.requestContext.authorizer;
}

/**
 * Request authorization type
 */
export type AuthorizerType = "iam" | "jwt" | "lambda" | "none"

/**
 * Return type of request authorizer.
 * @param r - request
 */
export function authorizerType(r: Request): AuthorizerType {
    if (isIAMAuthorizedRequest(r)) return "iam"
    if (isJWTAuthorizedRequest(r)) return "jwt"
    if (isLambdaAuthorizedRequest(r)) return "lambda"
    return "none"
}

export type Handler<I = any, O = any> = (event: I, context: Context) => Promise<O>

/**
 * Middleware function accepting request of type `TEvent`, converting it into `T` and calling `this.next` with it.
 */
type MiddlewareFunction<T, TEvent = Request> = (this: Middleware<T>, event: TEvent, context: Context) => Promise<unknown>

const PipelineNotReady: Handler = function () {
    throw new Error("Pipeline is not ready.")
}

/**
 * Middleware object holding reference to the next handler in the middleware chain
 */
export interface Middleware<TEvent = {}> {
    /**
     * Next request handler in the middleware chain
     */
    readonly next: Handler<Request & TEvent>
}

type Writeable<T> = {
    -readonly [P in keyof T]: T[P];
};
type PipelineStep = { middleware: MiddlewareFunction<unknown, any>, context: Writeable<Middleware<any>> }
type PipelineStart = MiddlewareFunction<unknown, any>

/**
 * Pipeline is a chain of middleware functions ending with a request handlers. Pipelines created with {@link pipeline}
 * function and then configured with {@link Pipeline.do} and {@link Pipeline.done} methods.
 * See {@link pipeline} for examples.
 */
export class Pipeline<TEvent = Request> {

    first?: PipelineStart
    last?: PipelineStep
    _done: boolean = false

    /**
     * Add [middleware function]{@link MiddlewareFunction} to the pipeline.
     * @param middleware - middleware function
     */
    do<TNext>(middleware: MiddlewareFunction<TNext, TEvent>) {
        this.assertNotDone()
        const context = {next: PipelineNotReady}
        middleware = middleware.bind(context)
        if (this.first === undefined) {
            this.first = middleware
        }
        if (this.last !== undefined) {
            this.last.context.next = middleware
        }
        this.last = {middleware, context}
        return this as any as Pipeline<TNext & TEvent>
    }

    done(handler: Handler<TEvent, lambda.APIGatewayProxyResultV2<object>>): Handler<Request> {
        this.assertNotDone()
        this._done = true
        if (this.first === undefined) {
            return handler as Handler<Request>
        }
        if (this.last !== undefined) {
            this.last.context.next = handler
        }
        return this.first
    }

    private assertNotDone() {
        if (this._done) throw new Error("Cannot use completed pipeline")
    }
}

/**
 * Create new empty [pipeline]{@link Pipeline}.
 *
 * @example add inline middleware
 * export const handler = pipeline()
 *      .do(async function (this: Middleware, event: Request, context: Context) {
 *          try {
 *              return await this.next(e, ctx)
 *          } catch (e) {
 *              return {
 *                  statusCode: 400
 *                  message: e.message
 *              }
 *          }
 *      })
 *      .done(function (e) {
 *          throw new Error()
 *      })
 *
 * @example use middleware function
 * export const handler = pipeline()
 *      .do(handleErrors)
 *      .done(function (e) { throw new Error() })
 *
 * async function handleErrors(this: Middleware, e: Request, ctx: Context) {
 *      try {
 *          return await this.next(e, ctx)
 *      } catch (e) {
 *          return {
 *              statusCode: 400
 *              message: e.message
 *          }
 *      }
 * }
 *
 * @example amend pipeline interface with a middleware function from above example
 * declare module "lambda" {
 *  interface Pipeline<TEvent = Request> {
 *     handleErrors(): Pipeline<TEvent>
 *  }
 *
 *  Pipeline.prototype.handleErrors = function () {
 *     return this.do(handleErrors)
 *  }
 * }
 * //use `handleErrors` method instead of `do`
 * export const handler = pipeline()
 *  .handleErrors()
 *  .done(function (e) { throw new Error() })
 */
export function pipeline() {
    return new Pipeline()
}

interface JsonRequest {
    json: object
}

/**
 * See {@link Pipeline.parseJsonBody}.
 */
export function parseJsonBody(this: Middleware<JsonRequest>, event: Request, context: Context) {
    const {body, isBase64Encoded} = event
    const request = event as Request & JsonRequest
    if (body !== undefined) {
        try {
            const data = isBase64Encoded ? Buffer.from(body, 'base64').toString() : body
            request.json = JSON.parse(data)
        } catch (e) {
            throw withErrorContext(e, "parseJsonBody")
        }
    }
    return this.next(request, context)
}

export interface Pipeline<TEvent = Request> {
    /**
     * Parse request body into json and set it into [`json` field]{@link JsonRequest.json}.
     */
    parseJsonBody(): Pipeline<TEvent & JsonRequest>
}

Pipeline.prototype.parseJsonBody = function () {
    return this.do(parseJsonBody)
}

type HttpMethod = "GET" | "PUT" | "POST" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS"

interface RouteEvent {
    route: `${HttpMethod} ${string}`
}

/**
 * See {@link addRoute}.
 */
export function addRoute(this: Middleware<RouteEvent>, event: Request, context: Context) {
    const request = event as Request & RouteEvent
    request.route = `${event.requestContext.http.method} ${event.routeKey}` as any
    return this.next(request, context)
}

export interface Pipeline<TEvent = Request> {
    /**
     * Add [route]{@link RouteEvent.route} key to the request combining HTTP method and [routeKey]{@link https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html}.
     * @example
     * export const handler = pipeline()
     *  .addRoute()
     *  .done(function (e) {
     *      switch(e.route) {
     *          case "POST /users": return postUsers(e)
     *          case "GET /users": return getUsers(e)
     *          case "PUT /users/{userId}": return putUser(e)
     *          case "DELETE /users/{userId}": return deleteUsers(e)
     *          default: throw new Error("Unknown route " + e.route)
     *      }
     *  })
     */
    withRoute(): Pipeline<TEvent & RouteEvent>
}

Pipeline.prototype.withRoute = function () {
    return this.do(addRoute)
}

/**
 * See {@link Pipeline.requireIAMAuth}.
 */
export function requireIAMAuth(this: Middleware<IAMAuthorizedRequest>, e: Request, ctx: Context) {
    if (!isIAMAuthorizedRequest(e)) {
        throw new Error()
    }
    return this.next(e, ctx)
}

/**
 * See {@link Pipeline.requireJWTAuth}.
 */
export function requireJWTAuth(this: Middleware<JWTAuthorizedRequest>, e: Request, ctx: Context) {
    if (!isJWTAuthorizedRequest(e)) {
        throw new Error()
    }
    return this.next(e, ctx)
}

/**
 * See {@link Pipeline.requireLambdaAuth}.
 */
export function requireLambdaAuth<T = unknown>(this: Middleware<LambdaAuthorizedRequest<T>>, e: Request, ctx: Context) {
    if (!isLambdaAuthorizedRequest<T>(e)) {
        throw new Error()
    }
    return this.next(e, ctx)
}

export interface Pipeline<TEvent = Request> {
    /**
     * Check if request is authorized with IAM. Throw an error if not.
     */
    requireIAMAuth(): Pipeline<TEvent & IAMAuthorizedRequest>

    /**
     * Check if request is authorized with JWT. Throw an error if not.
     */
    requireJWTAuth(): Pipeline<TEvent & JWTAuthorizedRequest>

    /**
     * Check if request is authorized with AWS Lambda (aka custom authorizer). Throw an error if not.
     */
    requireLambdaAuth<T = any>(): Pipeline<TEvent & LambdaAuthorizedRequest<T>>
}

Pipeline.prototype.requireIAMAuth = function () {
    return this.do(requireIAMAuth)
}
Pipeline.prototype.requireJWTAuth = function () {
    return this.do(requireJWTAuth)
}
Pipeline.prototype.requireLambdaAuth = function <T = unknown>() {
    return this.do(requireLambdaAuth<T>)
}

export async function handleErrors(this: Middleware, e: Request, ctx: Context) {
    try {
        return await this.next(e, ctx)
    } catch (e) {

        if (e instanceof SyntaxError) {
            //cannot parse json
        }

        return {
            statusCode: 400
        }
    }
}

export type TracedEvent = { tracer: Tracer }

interface RequestTracingOptions {
    /**
     * Tracer object. Default is a tracer with tag = `api`.
     */
    tracer?: Tracer
    /**
     * A function generating request tracing tag ({@link startSession}. Default is `${context.functionName}.${context.functionVersion}`.
     */
    tag?: (event: Request, context: Context) => string
}

const defaultApiTracer = new Tracer("api");

/**
 * See {@link Pipeline.traceRequest}.
 */
export function traceRequest(options: RequestTracingOptions = {}): MiddlewareFunction<TracedEvent> {
    const requestTracer = options.tracer ?? defaultApiTracer
    const tag = options.tag ?? function (_, ctx) {
        return `${ctx.functionName}.${ctx.functionVersion}`
    }

    return async function (this: Middleware<TracedEvent>, e: Request, ctx: Context) {
        const tracer = requestTracer.startSession(tag(e, ctx), e, ctx)
        const {requestContext: {authorizer, ...requestContext}, ...rest} = e
        const eventToTrace = {
            ...rest,
            requestContext: {...requestContext}
        }
        tracer.info("Started", {event: eventToTrace, context: {...ctx}})
        try {
            const event = e as Request & TracedEvent
            event.tracer = tracer
            const result = await this.next(event, ctx)
            tracer.info("Finished", {result})
            return result
        } catch (e) {
            tracer.error(e)
            throw e
        } finally {
            tracer.done()
        }
    }
}

export interface Pipeline<TEvent = Request> {
    /**
     * Write info message with request and context at start and error event if a handler in the middleware chain throws an error.
     * Request tracer is available in the `tracer` field of the request.
     * @param options - tracing options.
     * @example
     * const handler = pipeline()
     *     .traceRequest()
     *     .done(function (e) {
     *         e.tracer.info("This is completely useless info trace")
     *         return { statusCode: 200 }
     *     })
     */
    traceRequest(options?: RequestTracingOptions): Pipeline<TEvent & TracedEvent>
}

Pipeline.prototype.traceRequest = function (options: RequestTracingOptions = {}) {
    return this.do(traceRequest(options))
}
//
// const handler = pipeline()
//     .do(handleErrors)
//     .do(async function (this: Middleware, e: Request, ctx: Context) {
//         try {
//             return await this.next(e, ctx)
//         } catch (e) {
//             return {
//                 statusCode: 400
//             }
//         }
//     })
//     .traceRequest()
//     .withRoute()
//     .requireLambdaAuth<{ x: string }>()
//     .parseJsonBody()
//     .done(async function (e) {
//         console.log(e.json)
//         console.log(e.requestContext.authorizer.lambda.x)
//         e.tracer.info("Started")
//         return {}
//     })
