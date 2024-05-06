import {
    TSchema,
    StaticDecode,
    TUnknown,
    TypeBoxError,
    Type,
    TObject,
    TProperties, Kind
} from "@sinclair/typebox";
import {TypeCheck, TypeCompiler} from "@sinclair/typebox/compiler";
import {ValueError} from "@sinclair/typebox/errors";
import {ValueOf} from "type-fest";
import {Context} from "aws-lambda";
import _ from "lodash";
import {SecurityRequirementObject} from "openapi3-ts/src/model/openapi31";
import {Middleware, Pipeline, LambdaRequest} from "./pipeline"
import {HttpError} from "./errors";
import {Value} from "@sinclair/typebox/value";

const HttpMethods = ["GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS", "ANY"] as const
type HttpMethod = typeof HttpMethods[number]

export function isHttpMethod(x: any): x is HttpMethod {
    return HttpMethods.indexOf(x) >= 0
}

export type HttpStatus = number | 'default'

export function toStatusCode(x: any): HttpStatus {
    if (typeof x === 'number') return x
    if (typeof x === "string" && !isNaN(Number(x))) return Number(x)
    if (x === 'default') return x
    throw new Error(`Cannot convert ${x} to HTTP Status`)
}

/**
 * Gateway route matching API GW [spec]{@link https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-routes.html}.
 * @example - simple route
 * GET /users
 * @example - route with path
 * PUT /user/{id}
 * @example - ANY route with a wildcard
 * ANY /user/{proxy+}
 */
export type RouteKey = `${HttpMethod} ${string}` | '$default'

export interface SchemaMap extends TProperties {
    [Kind]?: never
}

/**
 * Define request parameters and response value.
 */
export type Operation = {
    /**
     * Operation identifier
     */
    operationId?: string
    /**
     * Operation summary
     */
    summary?: string
    /**
     * Operation description
     */
    description?: string
    /**
     * Request body schema.
     */
    body?: TSchema,
    /**
     * Request query schema.
     * @example - q=<string>&limit=<number>&page=<number>
     * {
     *     q: Type.String({maxLength: 1024}),
     *     limit: Type.Number({minimum: 1, maximum: 500}),
     *     page: Type.Number({minimum: 0})
     * }
     */
    query?: SchemaMap,
    /**
     * Request path schema
     * @example - /users/{id}
     * {
     *     "id": Type.String({maxLength: 12, minLength: 12})
     * }
     */
    path?: SchemaMap,
    /**
     * Request headers schema
     * @example - X-API-Key: <API KEY>, X-Client-Id:<Client ID>
     * {
     *     "X-API-Key": Type.String(),
     *     "X-Client-Id": Type.Number(),
     * }
     */
    headers?: SchemaMap,
    /**
     * Request cookies schema
     * @example - StickySessionID=SessionID
     * {
     *     "StickySessionID": Type.String()
     * }
     */
    cookies?: SchemaMap,
    /**
     * Successful response schema.
     */
    success?: TSchema
    /**
     * Successful response status code, default - 200
     */
    successStatusCode?: HttpStatus
    /**
     * Route responses, override {@link success} if status codes matches.
     */
    responses?: ({ [key in HttpStatus]?: TSchema } | HttpStatus)[]
    /**
     * Route security requirements in OpenAPI format
     */
    security?: SecurityRequirementObject[]
    /**
     * Route deprecation status
     */
    deprecated?: boolean
    /**
     * Operation tags
     */
    tags?: string[],
} & { [key: string]: any }
/**
 * Collection of routes. Note how typical use case adds `as const satisfies RouteMap` right after route map definition.
 * @example - simple user management API
 *    const UserRequest = Type.Object({
 *         name: Type.String({minLength: 3, maxLength: 100}),
 *         age: Type.Number({minimum: 0, maximum: 150})
 *     })
 *     const UserId = {id: Type.Number({minimum: 0})}
 *     const User = Type.Object({
 *         ...UserRequest.properties,
 *         ...UserId
 *     })
 *     const UserAPI = {
 *         "POST /users": {
 *             body: UserRequest,
 *             responses: [{200:User}]
 *         },
 *         "GET /user/{id}": {
 *             path: UserId,
 *             query: {
 *                 name: Type.Optional(UserRequest.properties.name),
 *                 age: Type.Optional(UserRequest.properties.age),
 *             },
 *             success: User
 *         },
 *         "PUT /user/{id}": {
 *             path: UserId,
 *             responses: [{200:User}]
 *         }
 *     } as const satisfies RouteMap
 */
export type RouteMap = { [key in RouteKey]?: Operation }

/**
 * Route event has {@link routeKey} with values from {@link RouteMap}
 */
export type RouteEvent<T extends RouteMap> = ValueOf<{
    [key in keyof T]: T[key] extends Operation ? {
            /**
             * {@link routeKey} with a [route]{@link RouteKey} from a {@link RouteMap}
             */
            readonly routeKey: key,
            /**
             * Collection of request part parsers.
             */
            readonly parsers: Parsers,
            /**
             * Request cookies' array converted into a map
             */
            readonly cookiesMap?: Record<string, string>,
            /**
             * Route information
             */
            readonly route: T[key]
            /**
             * Parse all request parts, if any part does not match it's schema then throw a {@link TypeBoxError}.
             * @example
             * const {body, path, query} = req.parse()
             */
            parse(): ParseResult<T[key]>,
            /**
             * Validate all request parts without throwing an error.
             * @example
             * const {body, path, query} = req.validate()
             */
            validate(): ValidationResult<T[key]>
        }
        : never
}>

interface RoutesMiddlewareOptions {
    /**
     * Don't raise 404 if lambda receives an unknown {@link LambdaRequest.routeKey}. Default - false.
     */
    allowUnknownRoutes?: boolean,
}

declare module "./pipeline" {
    interface Pipeline<TEvent = LambdaRequest> {
        /**
         * Verifies that incoming request matches one of the routes and attaches methods to parse and validate request parameters.
         *
         * Before using this middleware make sure the request body parsed into JSON using {@link parseJsonBody} or similar middleware.
         *
         * See {@link RouteMap} for example API definition.
         * @example - sample users API
         * //in users/index.ts
         * // See RouteMap example for API definition
         * import api from "@src/users/routes.ts"
         *
         * export const handler = pipeline()
         *  .withRoutes(Api)
         *  .parseJsonBody()
         *  .done(async function (e) {
         *      switch(e.route) {
         *          case "POST /users": {
         *              const {body} = e.parse()
         *              return await createUser(body)
         *          }
         *          case "GET /user/{id}": {
         *              const {path:{id}, query} = e.parse()
         *              return await getUser(id, query)
         *          }
         *          case "PUT /user/{id}": {
         *              const {path:{id}, body} = e.parse()
         *              return await putUser(id, body)
         *          }
         *      }
         *  })
         *  //in aws/api.ts
         *  import api from "@src/user/routes.ts"
         *  import {newApiGwIntegration, newLambda} from "@aws/util"
         *  const lambda = newLambda({ module: 'users', handler: 'handler' }).build()
         *  newApiGwIntegration(gateway.id, lambda)
         *     .addRoutes(api)
         */
        withRoutes<T extends RouteMap>(api: T, options?: RoutesMiddlewareOptions): Pipeline<TEvent & RouteEvent<T>>
    }
}

Pipeline.prototype.withRoutes = function <T extends RouteMap>(api: T, options?: RoutesMiddlewareOptions) {
    const allowUnknownRoutes = options?.allowUnknownRoutes ?? false
    const routes = new Set<string>(Object.keys(api))
    const parsers = routeParsers(api)

    return this.do(function (this: Middleware, event: LambdaRequest, context: Context) {
        const {routeKey} = event
        const knownRoute = allowUnknownRoutes || routes.has(routeKey);
        if (!knownRoute) {
            return Promise.resolve({statusCode: 404})
        }
        const request = event as LambdaRequest & RouteEvent<T>
        const p = parsers[event.routeKey as keyof T]
        Object.defineProperty(request, 'parsers', {value: p, configurable: true})
        Object.defineProperty(request, 'parse', {value: parse, configurable: true})
        Object.defineProperty(request, 'route', {value: api[event.routeKey as keyof T], configurable: true})
        Object.defineProperty(request, 'validate', {value: validate, configurable: true})
        Object.defineProperty(request, 'cookieMap', {value: cookieMap, configurable: true})
        return this.next(request, context)
    })
}

/**
 * Parse or validate predefined property from a request
 */
class RequestParser<T extends TSchema, P extends string> {
    private _check: TypeCheck<T>;

    private constructor(private readonly schema: T,
                        private readonly prop: P,
                        private readonly bodyParser: boolean) {
        this._check = TypeCompiler.Compile(schema)
    }

    private getProp(e: { [key in P]?: unknown }) {
        let val = e[this.prop]
        if (this.bodyParser) return val

        //Non-body request elements (query, path, headers, cookies) needs a special treatment.
        //1. They have to be at least an empty object, otherwise schema validation fails even if all schema elements
        // are optional. E.g. this fails `query: { q: Type.Optional(Type.String()) }` because there is no root object.
        // This fails as well - `query: Type.Optional({ q: Type.Optional(Type.String()) })`.
        //2. They represented as string, but JSON schema defines them as numbers, booleans and other primitive types.
        if (val === undefined) val = {}
        val = Value.Convert(this.schema, val)
        return val
    }

    parse(e: { [key in P]?: unknown }) {
        let value: any = this.getProp(e)
        return this._check.Decode(value)
    }

    errors(e: { [key in P]?: unknown }) {
        return Array.from(this._check.Errors(this.getProp(e)))
    }

    check(e: { [key in P]?: unknown }) {
        return this._check.Check(this.getProp(e))
    }

    static jsonBodyParser<Body extends TSchema>(schema: Body) {
        return new RequestParser(schema, "json", true)
    }

    static pathParser<T extends TProperties>(schema: T) {
        return new RequestParser(Type.Object(schema), "pathParameters", false)
    }

    static queryParser<T extends TProperties>(schema: T) {
        return new RequestParser(Type.Object(schema), "queryStringParameters", false)
    }

    static headersParser<T extends TProperties>(schema: T) {
        return new RequestParser(Type.Object(schema), "headers", false)
    }

    static cookiesParser<T extends TProperties>(schema: T) {
        return new RequestParser(Type.Object(schema), "cookiesMap", false)
    }
}

interface Parsers {
    body: RequestParser<TUnknown, "json">,
    query: RequestParser<TUnknown, "queryStringParameters">,
    path: RequestParser<TUnknown, "pathParameters">,
    headers: RequestParser<TUnknown, "headers">,
    cookies: RequestParser<TUnknown, "cookiesMap">,
}

/**
 * Map {@link RouteMap} to an object mapping routes to [request parsers]{@link RequestParser}.
 * @param routes
 */
function routeParsers<T extends RouteMap>(routes: T) {
    return _.mapValues(routes, function (route: any) {
        return {
            body: route.body !== undefined ? RequestParser.jsonBodyParser(route.body) : undefined,
            query: route.query !== undefined ? RequestParser.queryParser(route.query) : undefined,
            path: route.path !== undefined ? RequestParser.pathParser(route.path) : undefined,
            headers: route.headers !== undefined ? RequestParser.headersParser(route.headers) : undefined,
            cookies: route.cookies !== undefined ? RequestParser.cookiesParser(route.cookies) : undefined,
        }
    }) as any
}

function parse(this: LambdaRequest & RouteEvent<any>) {
    return {
        body: 'json' in this ? this.parsers.body?.parse(this) : undefined,
        path: this.parsers.path?.parse(this),
        query: this.parsers.query?.parse(this),
        headers: this.parsers.headers?.parse(this),
        cookies: this.parsers.cookies?.parse(this),
    }
}

function validate(this: LambdaRequest & RouteEvent<any>) {
    return {
        body: 'json' in this ? this.parsers.body?.errors(this) : undefined,
        path: this.parsers.path?.errors(this),
        query: this.parsers.query?.errors(this),
        headers: this.parsers.headers?.errors(this),
        cookies: this.parsers.cookies?.errors(this),
    }
}

function cookieMap(this: LambdaRequest & RouteEvent<any>): Record<string, string> | undefined {
    if (this.cookies === undefined) return undefined
    return _(this.cookies)
        .map(x => {
            const [name, value] = x.split('=');
            return {name, value};
        })
        .keyBy('name')
        .mapValues(x => x.value)
        .value()
}

type RequestPart = "body" | "path" | "query" | "headers" | "cookies"

//<!-- @formatter:off -->
type DecodedValue<T> =
    T extends TSchema ? StaticDecode<T>
  : T extends TProperties ? StaticDecode<TObject<T>>
  : never
//<!-- @formatter:on -->

type ParseResult<T extends Operation> = {
    [key in RequestPart]: DecodedValue<T[key]>
}

//<!-- @formatter:off -->
type ValidationError<T> =
    T extends TSchema ? ValueError[]
  : T extends TProperties ? ValueError[]
  : never
//<!-- @formatter:on -->

type ValidationResult<T extends Operation> = {
    [key in RequestPart]: ValidationError<T[key]>
}

declare module "@sinclair/typebox" {
    interface TypeBoxError extends HttpError {
        readonly statusCode: string
    }
}
Object.defineProperty(TypeBoxError.prototype, 'statusCode', {
    value: '400',
    writable: true
})
