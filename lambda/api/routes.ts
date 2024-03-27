import {TSchema, StaticDecode, TUnknown, TypeBoxError} from "@sinclair/typebox";
import {TypeCheck, TypeCompiler} from "@sinclair/typebox/compiler";
import {ValueError, ValueErrorIterator} from "@sinclair/typebox/errors";
import {ValueOf} from "type-fest";
import {Context} from "aws-lambda";
import _ from "lodash";
import {Middleware, Pipeline, Request} from "./pipeline"

type HttpMethod = "GET" | "PUT" | "POST" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "ANY"
/**
 * Gateway route matching API GW [spec]{@link https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-routes.html}.
 * @example - simple route
 * GET /users
 * @example - route with path
 * PUT /user/{id}
 * @example - ANY route with a wildcard
 * ANY /user/{proxy+}
 */
type Route = `${HttpMethod} ${string}`

/**
 * Define request parameters and response value.
 */
type RequestSpec = {
    /**
     * Request body schema.
     */
    body?: TSchema,
    /**
     * Request query schema.
     * @example - q=<string>&limit=<number>&page=<number>
     * Type.Object({
     *     q: Type.String({maxLength: 1024}),
     *     limit: Type.Number({minimum: 1, maximum: 500}),
     *     page: Type.Number({minimum: 0})
     * })
     */
    query?: TSchema,
    /**
     * Request path schema
     * @example - /users/{id}
     * Type.Object({
     *     id: Type.String({maxLength: 12, minLength: 12})
     * })
     */
    path?: TSchema,
    /**
     * Response schema
     */
    res?: TSchema,
    /**
     * Operation identifier
     */
    operationId?: string
}
/**
 * Collection of routes. Note how typical use case adds `as const satisfies RouteMap` right after route map definition.
 * @example - simple user management API
 *    const UserRequest = Type.Object({
 *         name: Type.String({minLength: 3, maxLength: 100}),
 *         age: Type.Number({minimum: 0, maximum: 150})
 *     })
 *     const UserId = Type.Object({id: Type.Number({minimum: 0})})
 *     const User = Type.Object({
 *         ...UserRequest.properties,
 *         ...UserId.properties
 *     })
 *     const UserAPI = {
 *         "POST /users": {
 *             body: UserRequest,
 *             res: User
 *         },
 *         "GET /user/{id}": {
 *             path: UserId,
 *             query: Type.Object({
 *                 name: Type.Optional(UserRequest.properties.name),
 *                 age: Type.Optional(UserRequest.properties.age),
 *             }),
 *             res: User
 *         },
 *         "PUT /user/{id}": {
 *             path: UserId,
 *             res: User
 *         }
 *     } as const satisfies RouteMap
 */
export type RouteMap = {
    [key: Route]: RequestSpec
}

/**
 * Route event has {@link routeKey} with values from {@link RouteMap}
 */
export type RouteEvent<T extends RouteMap> = ValueOf<{
    [key in keyof T]: T[key] extends RequestSpec ? {
            /**
             * {@link routeKey} with a [route]{@link Route} from a {@link RouteMap}
             */
            routeKey: key,
            /**
             * Collection of request part parsers.
             */
            parsers: Parsers,
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
     * Don't raise 404 if lambda receives an unknown {@link Request.routeKey}. Default - false.
     */
    allowUnknownRoutes?: boolean,
}

declare module "./pipeline" {
    interface Pipeline<TEvent = Request> {
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

    return this.do(function (this: Middleware, event: Request, context: Context) {
        const {routeKey} = event
        const knownRoute = allowUnknownRoutes || routes.has(routeKey);
        if (!knownRoute) {
            return Promise.resolve({statusCode: 404})
        }
        const request = event as Request & RouteEvent<T>
        const p = parsers[event.routeKey as keyof T]

        request.parsers = p as any
        request.parse = parse as any
        request.validate = validate as any

        return this.next(request, context)
    })
}

/**
 * Parse or validate predefined property from a request
 */
class RequestParser<T extends TSchema, P extends string> {
    private _check: TypeCheck<T>;

    private constructor(schema: T, private readonly prop: P) {
        this._check = TypeCompiler.Compile(schema)
    }

    parse(e: { [key in P]?: unknown }) {
        return this._check.Decode(e[this.prop])
    }

    errors(e: { [key in P]?: unknown }) {
        return Array.from(this._check.Errors(e[this.prop]))
    }

    check(e: { [key in P]?: unknown }) {
        return this._check.Check(e[this.prop])
    }

    static jsonBodyParser<Body extends TSchema>(schema: Body) {
        return new RequestParser(schema, "json")
    }

    static pathParser<Body extends TSchema>(schema: Body) {
        return new RequestParser(schema, "pathParameters")
    }

    static queryParser<Body extends TSchema>(schema: Body) {
        return new RequestParser(schema, "queryStringParameters")
    }
}

interface Parsers {
    body: RequestParser<TUnknown, "json">,
    query: RequestParser<TUnknown, "queryStringParameters">,
    path: RequestParser<TUnknown, "pathParameters">,
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
        }
    }) as any
}

function parse(this: Request & RouteEvent<any>): ParseResult<any> {
    return {
        body: this.parsers.body?.parse(this as any),
        path: this.parsers.path?.parse(this),
        query: this.parsers.query?.parse(this),
    }
}

function validate(this: Request & RouteEvent<any>): ParseResult<any> {
    return {
        body: this.parsers.body?.errors(this as any),
        path: this.parsers.path?.errors(this),
        query: this.parsers.query?.errors(this),
    }
}

type DecodedValue<T extends TSchema | undefined> = T extends undefined
    ? never
    : StaticDecode<Exclude<T, undefined>>

type RequestPart = "body" | "path" | "query"

type ParseResult<T extends RequestSpec> = {
    [key in RequestPart]: DecodedValue<T[key]>
}

type ValidationErrors<T extends TSchema | undefined> = T extends undefined
    ? never
    : ValueError[]

type ValidationResult<T extends RequestSpec> = {
    [key in RequestPart]: ValidationErrors<T[key]>
}
