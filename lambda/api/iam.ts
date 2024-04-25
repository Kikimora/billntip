import * as lambda from "aws-lambda";
import {Middleware, Pipeline, LambdaRequest} from "./pipeline"
import {HttpError} from "./errors";

type IAM = lambda.APIGatewayEventRequestContextIAMAuthorizer
/**
 * API Gateway v2 IAM authorized request.
 */
export type IAMAuthorizedRequest = LambdaRequest<IAM> & { user: IAM['iam'] }

/**
 * Type assert for {@link IAMAuthorizedRequest}
 * @param r - request
 */
export function isIAMAuthorizedRequest(r: LambdaRequest<any>): r is IAMAuthorizedRequest {
    return 'iam' in r.requestContext.authorizer;
}

/**
 * API Gateway v2 JWT authorized request.
 */
type JWT = lambda.APIGatewayEventRequestContextJWTAuthorizer
export type JWTAuthorizedRequest = LambdaRequest<JWT> & { user: JWT }

/**
 * Type assert for {@link JWTAuthorizedRequest}
 * @param r - request
 */
export function isJWTAuthorizedRequest(r: LambdaRequest<any>): r is JWTAuthorizedRequest {
    return 'jwt' in r.requestContext.authorizer;
}

/**
 * API Gateway v2 Lambda (aka custom) authorized request.
 */
type LambdaAuth<T> = lambda.APIGatewayEventRequestContextLambdaAuthorizer<T>
export type LambdaAuthorizedRequest<T = unknown> = LambdaRequest<LambdaAuth<T>> & { user: T }

/**
 * Type assert for {@link LambdaAuthorizedRequest}
 * @param r - request
 */
export function isLambdaAuthorizedRequest<T = unknown>(r: LambdaRequest): r is LambdaAuthorizedRequest<T> {
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
export function authorizerType(r: LambdaRequest): AuthorizerType {
    if (isIAMAuthorizedRequest(r)) return "iam"
    if (isJWTAuthorizedRequest(r)) return "jwt"
    if (isLambdaAuthorizedRequest(r)) return "lambda"
    return "none"
}

export class NotAuthorizedError extends Error implements HttpError {
    constructor(message?: string) {
        super(message);
    }

    public readonly statusCode = '401'
}

/**
 * See {@link Pipeline.requireIAMAuth}.
 */
export function requireIAMAuth(e: LambdaRequest): asserts e is IAMAuthorizedRequest {
    if (!isIAMAuthorizedRequest(e)) {
        throw new NotAuthorizedError("IAM authorizer required for the event.")
    }
    Object.defineProperty(e, "user", {
        value: e.requestContext.authorizer.iam,
        configurable: true
    })
}

/**
 * See {@link Pipeline.requireJWTAuth}.
 */
export function requireJWTAuth(e: LambdaRequest): asserts e is JWTAuthorizedRequest {
    if (!isJWTAuthorizedRequest(e)) {
        throw new NotAuthorizedError("JWT authorizer required for the event.")
    }
    Object.defineProperty(e, "user", {
        value: e.requestContext.authorizer,
        configurable: true
    })
}

/**
 * See {@link Pipeline.requireLambdaAuth}.
 */
export function requireLambdaAuth<T = unknown>(e: LambdaRequest): asserts e is LambdaAuthorizedRequest<T> {
    if (!isLambdaAuthorizedRequest<T>(e)) {
        throw new NotAuthorizedError("Lambda authorizer required for the event.")
    }
    Object.defineProperty(e, "user", {
        value: e.requestContext.authorizer.lambda,
        configurable: true
    })
}

declare module "./pipeline" {
    export interface Pipeline<TEvent> {
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
}

Pipeline.prototype.requireIAMAuth = function () {
    return this.do(async function (this: Middleware<IAMAuthorizedRequest>, e, ctx) {
        requireIAMAuth(e)
        return await this.next(e, ctx)
    })
}
Pipeline.prototype.requireJWTAuth = function () {
    return this.do(async function (this: Middleware<JWTAuthorizedRequest>, e, ctx) {
        requireJWTAuth(e)
        return await this.next(e, ctx)
    })
}
Pipeline.prototype.requireLambdaAuth = function <T = unknown>() {
    return this.do(async function (this: Middleware<LambdaAuthorizedRequest<T>>, e, ctx) {
        requireLambdaAuth<T>(e)
        return await this.next(e, ctx)
    })
}