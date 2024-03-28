import {Tracer} from "@app/diagnostics";
import {Context} from "aws-lambda";
import {Middleware, MiddlewareFunction, Pipeline} from "./pipeline";

export type TracedEvent = { tracer: Tracer }

interface RequestTracingOptions {
    /**
     * Tracer object. Default is a tracer with tag = `api`.
     */
    tracer?: Tracer
    /**
     * Request tracing tag or tag generating function (see {@link startSession}. Default is `${context.functionName}.${context.functionVersion}`.
     */
    tag?: string | ((event: any, context: Context) => string)
}

const defaultApiTracer = new Tracer("api");

/**
 * See {@link Pipeline.traceRequest}.
 */
export function traceRequest(options: RequestTracingOptions = {}): MiddlewareFunction<TracedEvent> {
    const requestTracer = options.tracer ?? defaultApiTracer
    let {tag} = options
    if (tag === undefined) {
        tag = function (_, ctx) {
            return `${ctx.functionName}.${ctx.functionVersion}`
        }
    }
    if (typeof tag === "string") {
        const constTag = tag;
        tag = function () {
            return constTag
        }
    }

    return async function (this: Middleware<TracedEvent>, e: any, ctx: Context) {
        const tracer = e.tracer ?? requestTracer.startSession(tag(e, ctx), e, ctx)
        try {
            tracer.info("Started", {event: eventData(e), context: {...ctx}})
            const event = e as TracedEvent
            //Define property such that it does not show up in JSON serialisation.
            //This is critical in some cases such as Cognito Lambda Triggers which return event (their input) as their response.
            //If returned event contains 'tracer' property then some Lambda Triggers fail.
            Object.defineProperty(event, 'tracer', {
                value: tracer,
                enumerable: false,
                configurable: false,
                writable: false
            })
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

    function eventData(e: any) {
        if ('requestContext' in e) {
            //Remove authorizer from API GW request
            const {requestContext: {authorizer, ...requestContext}, ...rest} = e
            return {
                ...rest,
                requestContext: {...requestContext}
            }
        } else {
            return e
        }
    }
}

declare module "./pipeline" {

    export interface Pipeline<TEvent> {
        /**
         * Adds `tracer` to the request if it is not already there. Write info message with request and context at start and
         * error event if a handler in the middleware chain throws an error.
         *
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

}
Pipeline.prototype.traceRequest = function (options: RequestTracingOptions = {}) {
    return this.do(traceRequest(options))
}
