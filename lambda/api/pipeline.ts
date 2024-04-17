import {Context} from "aws-lambda";
import * as lambda from "aws-lambda";

/**
 * AWS Lambda API gateway v2 request (aka API Gateway event).
 */
export interface LambdaRequest<TAuthorizer = unknown> {
    version: string;
    readonly routeKey: string;
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

type Handler<I = any, O = any> = (event: I, context: Context) => Promise<O>

/**
 * Middleware function accepting request of type `TEvent`, converting it into `T` and calling `this.next` with it.
 */
export type MiddlewareFunction<T, TEvent = LambdaRequest> = (this: Middleware<T>, event: TEvent, context: Context) => Promise<unknown>

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
    readonly next: Handler<TEvent>
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
export class Pipeline<TEvent = LambdaRequest> {

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

    done(handler: Handler<TEvent>): Handler {
        this.assertNotDone()
        this._done = true
        if (this.first === undefined) {
            return handler as Handler<TEvent>
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
export function pipeline<T = LambdaRequest>() {
    return new Pipeline<T>()
}
