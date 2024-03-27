import {Middleware, Pipeline, Request} from "./pipeline";
import {Context} from "aws-lambda";

export interface JsonRequest {
    json: unknown
}

/**
 * {@link Pipeline.parseJsonBody} options
 */
interface ParseJsonBodyOptions {
    /**
     * Throw error if request does not have 'content-type:application/json' header.
     */
    checkContentType?: boolean
}

declare module "./pipeline" {
    export interface Pipeline<TEvent> {
        /**
         * Parse request body into json and set it into [`json` field]{@link JsonRequest.json}.
         */
        parseJsonBody(options?: ParseJsonBodyOptions): Pipeline<TEvent & JsonRequest>
    }
}

export class JsonBodyError extends Error {
    constructor(message?: string) {
        super(message);
    }
}

Pipeline.prototype.parseJsonBody = function (options?: ParseJsonBodyOptions) {

    const checkHeader = options?.checkContentType ?? true

    return this.do(async function (this: Middleware<JsonRequest>, event: Request, context: Context) {
        const {body, isBase64Encoded} = event
        if (body !== undefined && checkHeader && event.headers['Content-Type'] !== 'application/json') {
            throw new JsonBodyError("Missing required 'Content-Type: application/json' header")
        }
        const request = event as Request & JsonRequest
        if (body !== undefined) {
            try {
                const data = isBase64Encoded ? Buffer.from(body, 'base64').toString() : body
                request.json = JSON.parse(data)
            } catch (e: any) {
                throw new JsonBodyError(e.message)
            }
        }
        return await this.next(request, context)
    })
}
