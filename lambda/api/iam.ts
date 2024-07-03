import * as lambda from "aws-lambda";
import {Middleware, Pipeline, LambdaRequest} from "./pipeline"
import {AppError, HttpError} from "./errors";
import {Static, TSchema, TUnknown, Type} from "@sinclair/typebox";
import {TypeCheck, TypeCompiler} from "@sinclair/typebox/compiler";

type IAM = lambda.APIGatewayEventRequestContextIAMAuthorizer
/**
 * API Gateway v2 IAM authorized request.
 */
export type IAMAuthorizedRequest = LambdaRequest<IAM> & { principal: IAM['iam'] }

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
const JWTClaimsSchema = Type.Record(Type.String(), Type.Union([
    Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())
]))
type JWTClaims = Static<typeof JWTClaimsSchema>

interface JWT<T = unknown> {
    principalId: string;
    integrationLatency: number;
    jwt: {
        claims: T;
        scopes: string[];
    };
}

export type JWTAuthorizedRequest<T = JWTClaims> = LambdaRequest<JWT<T>> & { principal: JWT<T> }

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
export type LambdaAuthorizedRequest<T = unknown> = LambdaRequest<LambdaAuth<T>> & { principal: T }

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

export class NotAuthorizedError extends AppError implements HttpError {
    constructor(message: string = "Not Authorized") {
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
    Object.defineProperty(e, "principal", {
        value: e.requestContext.authorizer.iam,
        configurable: true
    })
}

/**
 * See {@link Pipeline.requireJWTAuth}.
 */
export function requireJWTAuth<S extends TSchema>(e: LambdaRequest, checker?:TypeCheck<S>): asserts e is JWTAuthorizedRequest<Static<S>> {
    if (!isJWTAuthorizedRequest(e)) {
        throw new NotAuthorizedError("JWT authorizer required for the event.")
    }
    if (checker !== undefined) {
        const errors = Array.from(checker.Errors(e.requestContext.authorizer.jwt.claims))
        if (errors.length > 0) {
            throw new NotAuthorizedError()
                .withContext("requireJWTAuth", {errors})
        }
    }
    Object.defineProperty(e, "principal", {
        value: e.requestContext.authorizer,
        configurable: true
    })
}

/**
 * See {@link Pipeline.requireLambdaAuth}.
 */
export function requireLambdaAuth<S extends TSchema>(e: LambdaRequest, checker?: TypeCheck<S>): asserts e is LambdaAuthorizedRequest<Static<S>> {
    if (!isLambdaAuthorizedRequest<Static<S>>(e)) {
        throw new NotAuthorizedError("Lambda authorizer required for the event.")
    }
    if (checker !== undefined) {
        const errors = Array.from(checker.Errors(e.requestContext.authorizer.lambda))
        if (errors.length > 0) {
            throw new NotAuthorizedError()
                .withContext("requireLambdaAuth", {errors})
        }
    }
    Object.defineProperty(e, "principal", {
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
         * Check if request is authorized with JWT and JWT matches provided schema. Throw an error if not.
         */
        requireJWTAuth<S extends TSchema>(schema: S): Pipeline<TEvent & JWTAuthorizedRequest<Static<S>>>

        /**
         * Check if request is authorized with AWS Lambda (aka custom authorizer). Throw an error if not.
         */
        requireLambdaAuth(): Pipeline<TEvent & LambdaAuthorizedRequest>

        /**
         * Check if request is authorized with AWS Lambda (aka custom authorizer) and authorizer context matches
         * provided schema. Throw an error if not.
         */
        requireLambdaAuth<S extends TSchema>(schema: S): Pipeline<TEvent & LambdaAuthorizedRequest<Static<S>>>
    }
}

Pipeline.prototype.requireIAMAuth = function () {
    return this.do(async function (this: Middleware<IAMAuthorizedRequest>, e, ctx) {
        requireIAMAuth(e)
        return await this.next(e, ctx)
    })
}
Pipeline.prototype.requireJWTAuth = function <S extends TSchema>(schema?: S) {
    const s = schema !== undefined ? schema : JWTClaimsSchema
    const checker = TypeCompiler.Compile(s)
    type T = Static<typeof s>
    return this.do(async function (this: Middleware<JWTAuthorizedRequest<T>>, e, ctx) {
        requireJWTAuth(e, checker)
        return await this.next(e, ctx)
    })
}
Pipeline.prototype.requireLambdaAuth = function <S extends TSchema>(schema?: S) {
    const s = schema !== undefined ? schema : Type.Unknown()
    const checker = schema !== undefined ? TypeCompiler.Compile(schema) : undefined
    type T = Static<typeof s>
    return this.do(async function (this: Middleware<LambdaAuthorizedRequest<T>>, e, ctx) {
        requireLambdaAuth(e, checker)
        return await this.next(e, ctx)
    })
}
