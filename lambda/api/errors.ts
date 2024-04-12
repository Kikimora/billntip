import {Middleware, Pipeline} from "./pipeline";

export interface HttpError {
    readonly statusCode: number
}

declare module "./pipeline" {
    interface Pipeline {
        /**
         * Covert exceptions into error objects. If error has **`httpCode`** property then it's value used as a **`statusCode`**.
         * If error has `error` property then it's value used
         *
         * The error is build from an exception as follows
         * ```ts
         * const {name, message, statusCode, error, stack, ...rest} = exception
         * return {
         *   "statusCode": statusCode ?? 500,
         *   "body": JSON.stringify({
         *     error: name,
         *     message: message,
         *     ...(error ?? rest)
         *   })
         * }
         * ```
         */
        handleErrors(): Pipeline
    }
}

Pipeline.prototype.handleErrors = function () {
    return this.do(async function (this: Middleware, e, ctx) {
        try {
            return await this.next(e, ctx)
        } catch (exception: any) {
            const {
                name,
                message,
                statusCode,
                error,
                //Don't return stacktrace
                stack,
                //Don't return AWS noise
                $metadata, __type, $fault,
                ...rest
            } = exception
            return {
                "statusCode": statusCode ?? $metadata?.httpStatusCode ?? 500,
                "body": JSON.stringify({
                    error: name,
                    message: message,
                    ...(error ?? rest)
                })
            }
        }
    })
}