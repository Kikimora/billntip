import {Type} from "@sinclair/typebox";
import {Middleware, Pipeline} from "./pipeline";
import {ErrorContext, TraceAttributes, errorWithContext} from "@app/diagnostics";

export interface HttpError {
    readonly statusCode: string
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

const MaxErrorMessageLength = 1024;
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
                    error: String(name).substring(0, MaxErrorNameLength),
                    message: String(message).substring(0, MaxErrorMessageLength),
                    ...(error ?? rest)
                })
            }
        }
    })
}

const MaxErrorNameLength = 200;
export const ErrorSchema = Type.Object({
    error: Type.String({
        description: "Error type",
        example: "UserNotFoundException",
        maxLength: MaxErrorNameLength,
    }),
    message: Type.String({
        description: "Error message",
        example: "User does not exist.",
        maxLength: MaxErrorMessageLength
    }),
}, {additionalProperties: true})

export interface ErrorDetails {
    name?: string
    statusCode?: string

    [key: string]: any
}

export class AppError extends Error implements HttpError {

    public readonly error?: object
    public readonly statusCode: string

    constructor(message: string, details: ErrorDetails) {
        super(message);
        if (details !== undefined) {
            const {statusCode, name, ...rest} = details
            this.statusCode = statusCode ?? "unexpected"
            this.name = name ?? this.name
            Object.assign(this, rest)
        } else {
            this.statusCode = "unexpected"
        }
    }

    /**
     * Add context to the error (see {@link errorWithContext})
     * @param name - context name
     * @param value - context value
     */
    withContext(name: string, value?: TraceAttributes): AppError
    /**
     * Add context to the error (see {@link errorWithContext})
     * @param context - error context
     * @param value - context value overrides
     *
     * @example
     * // this function fetches a user from DynamoDB
     *     async fetch() {
     *         const user = ddb.get(Users, {
     *             key: userKey(this.username)
     *         })
     *         const context = {
     *             name: "fetch",
     *             value: {
     *                 username: this.username,
     *             }
     *         }
     *
     *         async function fetchUserItem() {
     *             try {
     *                 const {Item: item} = await db.getItem(user)
     *                 return item
     *             } catch (e: any) {
     * //Add error context and root cause to the error
     *                 throw internalServerError(e.message).withContext(context, {cause: e})
     *             }
     *         }
     *
     *         const item = await fetchUserItem()
     *         if (item === undefined) {
     * //Add error context to the error, there is no root cause in this case since it is user not found situation.
     *              throw userNotFoundException().withContext(context)
     *         }
     *         const {attributes} = unmarshall(item) as TableSchemaType<typeof Users>
     *         this.attributes = _.map(attributes, (value, name) => ({name, value}))
     *     }
     */
    withContext(context: ErrorContext, value?: TraceAttributes): AppError
    withContext(context: ErrorContext | string, value?: TraceAttributes) {
        if (typeof context === 'string')
            return errorWithContext(this, context, value)
        else
            return errorWithContext(this, context, value)
    }
}

export function internalServerError(message: string, details?: object) {
    return new AppError(message, {
        ...details,
        statusCode: '500',
        name: 'InternalServerError',
    })
}

export function badRequestError(message: string, details?: object) {
    return new AppError(message, {
        ...details,
        statusCode: '400',
        name: 'BadRequest',
    })
}

export function accessDeniedError(message: string = "Access denied.", details?: object) {
    return new AppError(message, {
        ...details,
        statusCode: '403',
        name: 'AccessDenied',
    })
}

export function notFoundError(message: string = "Resource does not exist.", details?: object) {
    return new AppError(message, {
        ...details,
        statusCode: '404',
        name: 'NotFound',
    })
}

export function conflictError(message: string, details?: object) {
    return new AppError(message, {
        ...details,
        statusCode: '409',
        name: 'Conflict',
    })
}
