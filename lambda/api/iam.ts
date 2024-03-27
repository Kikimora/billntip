import {Context} from "aws-lambda";
import * as lambda from "aws-lambda";
import {Middleware, Pipeline, Request} from "./pipeline"

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

export class IAMAuthorizerError extends Error {
    constructor(message?:string) {
        super(message);
    }
}

/**
 * See {@link Pipeline.requireIAMAuth}.
 */
export function requireIAMAuth(this: Middleware<IAMAuthorizedRequest>, e: Request, ctx: Context) {
    if (!isIAMAuthorizedRequest(e)) {
        throw new IAMAuthorizerError("IAM authorizer required for the event.")
    }
    return this.next(e, ctx)
}

/**
 * See {@link Pipeline.requireJWTAuth}.
 */
export function requireJWTAuth(this: Middleware<JWTAuthorizedRequest>, e: Request, ctx: Context) {
    if (!isJWTAuthorizedRequest(e)) {
        throw new IAMAuthorizerError("JWT authorizer required for the event.")
    }
    return this.next(e, ctx)
}

/**
 * See {@link Pipeline.requireLambdaAuth}.
 */
export function requireLambdaAuth<T = unknown>(this: Middleware<LambdaAuthorizedRequest<T>>, e: Request, ctx: Context) {
    if (!isLambdaAuthorizedRequest<T>(e)) {
        throw new IAMAuthorizerError("Lambda authorizer required for the event.")
    }
    return this.next(e, ctx)
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
    return this.do(requireIAMAuth)
}
Pipeline.prototype.requireJWTAuth = function () {
    return this.do(requireJWTAuth)
}
Pipeline.prototype.requireLambdaAuth = function <T = unknown>() {
    return this.do(requireLambdaAuth<T>)
}