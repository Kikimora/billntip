import * as oas31 from "openapi3-ts/oas31";
import _ from "lodash";
import {Static, TSchema, Type, TypeGuard} from "@sinclair/typebox";
import fs from "fs";
import yaml from "yaml";
import {IsUnknown} from "type-fest";
import {
    HttpStatus,
    isHttpMethod,
    Operation as ApiOperation,
    RouteKey,
    RouteMap,
    SchemaMap, toStatusCode
} from "./routes";
import {die} from "@app/util";

/**
 * OpenAPI specification builder.
 */
class Builder {

    private readonly _consumes: ContentType[] = []
    private readonly _produces: ContentType[] = []
    private readonly _paths: { [key in RouteKey]?: Operation<any> } = {}
    private readonly _doc: Partial<oas31.OpenAPIObject> = {
        openapi: "3.1.0",
    }

    /**
     * Load OpenAPI specification from file or an object
     * @param file - file or open API object.
     */
    spec(file: string | Partial<oas31.OpenAPIObject>) {
        if (typeof file === "string") {
            const content = fs.readFileSync(file).toString("utf8")
            _.merge(this._doc, yaml.parse(content, {merge: true}))
        } else {
            _.merge(this._doc, file)
        }
        return this
    }

    /**
     * Set OpenAPI top level [version]{@link https://swagger.io/specification#fixed-fields} field
     */
    version(v: string) {
        this._doc.openapi = v
        return this
    }

    /**
     * Set OpenAPI top level [info]{@link https://swagger.io/specification#fixed-fields} field
     */
    info(v: oas31.InfoObject) {
        this._doc.info = v
        return this
    }

    /**
     * Set OpenAPI top level [tags]{@link https://swagger.io/specification#fixed-fields} field
     */
    tags(v: oas31.TagObject[]) {
        this._doc.tags = v
        return this
    }

    /**
     * Set OpenAPI top level [externalDocs]{@link https://swagger.io/specification#fixed-fields} field
     */
    externalDocs(v: oas31.ExternalDocumentationObject) {
        this._doc.externalDocs = v
        return this
    }

    /**
     * Set OpenAPI top level [security]{@link https://swagger.io/specification#fixed-fields} field
     */
    security(v: oas31.SecurityRequirementObject[]) {
        this._doc.security = v
        return this
    }

    /**
     * Set OpenAPI top level [servers]{@link https://swagger.io/specification#fixed-fields} field
     */
    servers(v: oas31.ServerObject[]) {
        this._doc.servers = v
        return this
    }

    /**
     * Set OpenAPI [components]{@link https://swagger.io/specification#fixed-fields}.
     */
    components(v: oas31.ComponentsObject) {
        this._doc.components = v
        return this
    }

    /**
     * Set OpenAPI [webhooks]{@link https://swagger.io/specification#fixed-fields}.
     */
    webhooks(v: oas31.PathsObject) {
        this._doc.webhooks = v
        return this
    }

    consumes(contentType: MimeType, converter?: (x: any) => any) {
        this._consumes.push({mime: contentType, toContentType: converter ?? _.identity})
        return this
    }

    produces(contentType: MimeType, converter?: (x: any) => any) {
        this._produces.push({mime: contentType, toContentType: converter ?? _.identity})
        return this
    }

    response(statusCode: HttpStatus, response: ResponseBody<any>, id?: string) {
        this.docComponents.responses[id ?? statusCode] = this.makeOpenAPIResponse(response, statusCode)
        return this
    }

    /**
     * Defines OpenAPI [paths]{@link https://swagger.io/specification#paths-object} combining data
     * from {@link RouteMap} (see also {@link withRoutes}) and provided specification.
     *
     * Usually request schemas (e.g. body, response, path, query) come from routes while text descriptions,
     * examples, security and error details defined with the spec.
     *
     * @example
     * const api = openapi().spec("openapi.yaml").consumes('application/json');
     * api.paths(MyPaths).spec = {
     *  'GET /me': {
     *      summary: 'Get information about the user',
     *      security: [{'API_KEY': ['scope:user']}],
     *      responses: [
     *      {
     *          statusCode: 200,
     *          example: {id: 10}
     *      },
     *      400, 401
     *      ]
     *   }
     * }
     * const spec = api.build()
     */
    paths<T extends RouteMap>(routes: T) {
        const self = this
        //Create default specification purely from the route data
        for (const [k, route] of Object.entries(routes)) {
            const routeKey = k as RouteKey
            if (route === undefined) continue
            const op = self._paths[k as RouteKey] ?? (self._paths[k as RouteKey] = {})
            _.merge(op, makeOperationFromRoute(route, routeKey))
        }
        return {
            set spec(spec: PathsSpec<T>) {
                //Merge provided and generated specs.
                _.mergeWith(self._paths, spec, function (generatedValue, providedValue, key) {
                        if (key === 'response' && _.isArray(generatedValue) && _.isArray(providedValue)) {
                            //Merging responses is tricky because of the following rules:
                            //generated           + provided      = sum
                            //----------------------------------------------------------------------------------
                            //[{200: TSchema}] + [200]            = [{200: TSchema}] - default spec wins
                            //[{200: TSchema}] + [400]            = [{200: TSchema}, 400]
                            //[{200: TSchema}] + [{400: TSchema}] = [{200: TSchema}, {400: TSchema}]
                            //[{200: TSchema}] + [{200: TSchema}] = [{200: TSchema}] - merge default and provided
                            //below cases aren't possible because default spec always has form {statusCode:xyz}
                            //[400]            + [400]            = [400]
                            //[200]            + [400]            = [200, 400]
                            //
                            //These rules basically say:
                            // 1. if reference (number or 'default') provided, then use generated definition if available
                            // 2. if definition provided then use it

                            const merged: any[] = []
                            for (const x of generatedValue) {
                                if (typeof x === "object") {
                                    for (const statusCode of Object.keys(x)) {
                                        const matchIdx = providedValue.findIndex(x =>
                                            x === statusCode
                                            || x === Number(statusCode)
                                            || typeof x === 'object' && statusCode in x)
                                        if (matchIdx < 0) {
                                            merged.push(x)
                                            continue
                                        }
                                        const match = providedValue[matchIdx]
                                        if (typeof match === "number") {
                                            merged.push(x)
                                        } else {
                                            merged.push(_.merge(x, match))
                                        }
                                        providedValue.splice(matchIdx, 1)
                                    }
                                }
                            }
                            return merged.concat(providedValue)
                        }

                        return undefined
                    }
                )
            }
        }
    }

    /**
     * Build OpenAPI specification document.
     */
    build() {
        //return OpenAPI spec
        const doc = this._doc
        if (doc.openapi === undefined || doc.info === undefined)
            throw new Error("Cannot build OpenAPI sped without 'openapi' and 'info' fields.")

        const paths = doc.paths ?? (doc.paths = {})

        for (const [routeKey, op] of Object.entries(this._paths)) {
            if (op === undefined) continue
            const [method, path] = routeKey.split(' ')
            if (method === 'default' || path === undefined || !isHttpMethod(method)) continue

            const pathItem = paths[path] ?? (paths[path] = {})
            const m = method.toLowerCase() as keyof oas31.PathItemObject
            pathItem[m] = this.makeOpenApiOperation(op, routeKey as RouteKey)
        }
        return doc
    }

    private makeOpenApiOperation(op: Operation<any>, routeKey: RouteKey): oas31.OperationObject {

        let requestBody: oas31.RequestBodyObject | undefined = undefined;
        requestBody: {
            const body = op.body;
            if (body === undefined) break requestBody
            requestBody = {
                description: body.description,
                required: body.required,
                content: this.makeOpenAPIContent(body, bodyContentOverrides, this._consumes)
            }
        }

        let parameters
        const path = _(op.path).map((v, k) => this.toParameter(k, 'path', v)).value()
        const query = _(op.query).map((v, k) => this.toParameter(k, 'query', v)).value()
        const headers = _(op.headers).map((v, k) => this.toParameter(k, 'header', v)).value()
        const cookies = _(op.cookies).map((v, k) => this.toParameter(k, 'cookie', v)).value()
        parameters = path.concat(query).concat(headers).concat(cookies)

        let responses: oas31.ResponsesObject | undefined = undefined
        responses: {
            if (op.response === undefined) break responses

            responses = _(op.response)
                .flatMap((response: Response) => {
                    if (typeof response === "number" || response === 'default') {
                        return {statusCode: response, response: {$ref: `#/components/responses/${response}`}}
                    }
                    return _.map(response, (response, key) => {
                        if (response === undefined) return undefined
                        const statusCode = toStatusCode(key)
                        if (typeof response === "string") {
                            return {statusCode, response: {$ref: `#/components/responses/${response}`}}
                        }
                        if ('$ref' in response) {
                            return {statusCode, response}
                        }
                        return {
                            statusCode,
                            response: this.makeOpenAPIResponse(response, statusCode, routeKey)
                        }
                    })
                })
                .keyBy('statusCode')
                .mapValues('response')
                .value()
        }

        return {
            summary: op.summary,
            description: op.description,
            tags: op.tags,
            operationId: op.operationId,
            externalDocs: op.externalDocs,
            servers: op.servers,
            callbacks: op.callbacks,
            deprecated: op.deprecated,
            security: op.security,
            requestBody,
            responses,
            parameters
        }
    }

    private makeOpenAPIResponse(response: ResponseBody<any>, statusCode: HttpStatus, routeKey?: RouteKey) {
        return {
            description: response.description ?? httpStatusDescription(statusCode, routeKey),
            links: response.links,
            headers: response.headers,
            content: this.makeOpenAPIContent(response, responseContentOverrides, this._produces)
        };
    }

    private makeOpenAPIContent<T extends Content<any>>(contentObject: T,
                                                       getOverrides: (o: T) => { [mime: MimeType]: Content<any> },
                                                       contentTypes: ContentType[]
    ): oas31.ContentObject {

        const content = _(getOverrides(contentObject)).mapValues((x, mime) => {
            return this.toMediaTypeObject(x, contentTypes.find(x => x.mime == mime))
        }).value();

        //No overrides, use contentObject to build OpenAPI object.
        if (_.isEmpty(content)) {
            contentTypes.forEach((ct: ContentType) => {
                content[ct.mime] = this.toMediaTypeObject(contentObject, ct)
            })
        }
        return content
    }

    private toMediaTypeObject(contentObject: Content<any>, ct?: ContentType): oas31.MediaTypeObject {
        const {toContentType} = ct ?? {toContentType: _.identity}
        const example = contentObject.example !== undefined ? toContentType(contentObject.example) : undefined
        const examples = contentObject.examples === undefined
            ? undefined
            : _(contentObject.examples).mapValues(function (ex) {
                const {value, ...rest} = ex
                return {
                    value: toContentType(value),
                    ...rest
                } as oas31.ExampleObject
            }).value()
        return {
            schema: this.toSchema(contentObject.schema),
            example,
            examples,
            encoding: contentObject.encoding
        }
    }

    private toParameter(name: string, $in: oas31.ParameterLocation, param: Parameter<any>): oas31.ParameterObject {
        return {
            name: name,
            in: $in,
            description: param.description,
            required: param.required ?? (typeof param.schema === "object" && !TypeGuard.IsOptional(param.schema)),
            explode: param.explode,
            deprecated: param.deprecated,
            style: param.style,
            schema: this.toSchema(param.schema),
            allowReserved: param.allowReserved,
            allowEmptyValue: param.allowEmptyValue,
            example: param.example,
            examples: param.examples,
            content: param.content
        }
    }

    /**
     * Converts {@link TSchema} into {@ oas31.SchemaObject} or {@link oas31.ReferenceObject}.
     *
     * If {@link x} contains `$id` attribute then schema added to `#/components/schemas` and method return reference.
     * Otherwise, it returns JSON schema as is.
     *
     * @param x - schema or undefined
     */
    private toSchema(x?: TSchema): oas31.SchemaObject | oas31.ReferenceObject | undefined {
        if (x === undefined || x === null) return undefined
        if (x.$id !== undefined) {
            this.docComponents.schemas[x.$id] = Type.Strict(x)
            return {$ref: `#/components/schemas/${x.$id}`}
        }
        return Type.Strict(x)
    }

    private get docComponents(): { [key in keyof oas31.ComponentsObject]-?: oas31.ComponentsObject[key] } {
        const components = this._doc.components ?? (this._doc.components = {})
        components.schemas = components.schemas ?? {}
        components.responses = components.responses ?? {}
        components.parameters = components.parameters ?? {}
        components.examples = components.examples ?? {}
        components.requestBodies = components.requestBodies ?? {}
        components.headers = components.headers ?? {}
        components.securitySchemes = components.securitySchemes ?? {}
        components.links = components.links ?? {}
        components.callbacks = components.callbacks ?? {}
        return components as any
    }
}

export type OpenAPIBuilder = { [key in keyof Builder]: Builder[key] }

export function openapi(): OpenAPIBuilder {
    return new Builder()
}

type MimeType = `${string}/${string}`

/**
 * Content object defines schema and example values.
 */
interface Content<T extends TSchema> {
    example?: Static<T>
    examples?: Examples<T>
    encoding?: oas31.EncodingObject
    schema?: T
}

/**
 * Request body
 *
 * @example default content type
 *
 * //map {id:10} to <id>10</id>
 * declare function toXML(x:any):any
 *
 * const api = openapi().consumes('application/json').consumes('application/xml', toXML)
 * api.paths(Paths).spec = {
 *     'GET /my/path': {
 *         body: {
 *           example: { id: 10 }
 *         }
 *     }
 * }
 * //this produce
 * //paths:
 * //  /my/path:
 * //    get:
 * //       requestBody:
 * //           content:
 * //               application/json:
 * //                   example: { id: 10 }
 * //               application/xml:
 * //                   example: <id>10</id>
 *
 * @example content type overrides
 * const api = openapi().consumes('application/json').consumes('application/xml', toXML)
 * api.paths(Paths).spec = {
 *     'GET /my/path': {
 *         body: {
 *           schema: Type.Object({ id: Type.Number() }),
 *           example: { id: 10 },
 *           'application/xml': {
 *              example: '<id value="10"/>'
 *           }
 *         }
 *     }
 * }
 * //this produce
 * //paths:
 * //  /my/path:
 * //    get:
 * //       requestBody:
 * //           content:
 * //               application/json:
 * //                   schema: { $ref: '#/components/schemas/my_path_body' }
 * //                   example: { id: 10 }
 * //               application/xml:
 * //                   schema: { $ref: '#/components/schemas/my_path_body' }
 * //                   example: <id value="10"/>
 */
interface RequestBody<T extends TSchema> extends Content<T> {
    //WARNING: if you add a property here don't forget to edit `bodyContentOverrides` function below.
    description?: string
    required?: boolean

    [key: MimeType]: Content<T>
}

function bodyContentOverrides<T extends TSchema>(x: RequestBody<T>) {
    const {description, required, schema, example, examples, encoding, ...rest} = x
    return rest
}

type Body<T extends TSchema | undefined> = IsUnknown<T> extends true ? never
    : RequestBody<Exclude<T, undefined>>

interface ResponseBody<T extends TSchema> extends Content<T> {
    description?: string
    links?: oas31.LinksObject
    headers?: oas31.HeadersObject,

    //Note: if you add a property here don't forget to edit `responseContentOverrides` function below.
    [key: MimeType]: Content<T>
}

function responseContentOverrides<T extends TSchema>(x: ResponseBody<T>) {
    const {description, links, headers, schema, example, examples, encoding, ...rest} = x
    return rest
}

type Response = { [statusCode in HttpStatus]?: oas31.ReferenceObject | string | ResponseBody<any> } | HttpStatus;

interface Operation<O extends ApiOperation> {
    //Request details
    operationId?: string
    summary?: string
    description?: string
    deprecated?: boolean
    security?: oas31.SecurityRequirementObject[]
    externalDocs?: oas31.ExternalDocumentationObject
    servers?: oas31.ServerObject[]
    callbacks?: oas31.CallbacksObject
    tags?: string[],
    //Request parameters
    path?: Parameters<O['path']>
    query?: Parameters<O['query']>
    headers?: Parameters<O['headers']>
    cookies?: Parameters<O['cookies']>
    body?: Body<O['body']>
    //Response
    response?: Response[]
}

export type PathsSpec<T extends RouteMap> = {
    [key in keyof T]?: T[key] extends ApiOperation ? Operation<T[key]> : never
}

/**
 * Content type holds mime type and a function to produce content type examples from JS values (e.g. convert JSON to XML).
 */
interface ContentType {
    /**
     * Content type MIME
     */
    mime: MimeType
    /**
     * Converts from native JS objects into content type.
     * @param example
     */
    toContentType: (example: any) => any
}

type Examples<T extends TSchema> = {
    [title: string]: {
        summary?: string;
        description?: string;
        value?: Static<T>;
        externalValue?: string;
        [property: string]: any;
    }
}

interface Parameter<T extends TSchema> {
    description?: string
    required?: boolean
    explode?: boolean
    deprecated?: boolean
    style?: oas31.ParameterStyle
    allowReserved?: boolean
    allowEmptyValue?: boolean

    content?: oas31.ContentObject

    schema?: T
    example?: Static<T>
    examples?: Examples<T>
}

type Parameters<T extends SchemaMap | undefined> = T extends undefined
    ? never
    : { [key in keyof T]: T[key] extends TSchema ? Parameter<T[key]> : never }

function httpStatusDescription(statusCode: HttpStatus, routeKey?: RouteKey) {
    if (statusCode === 'default') return 'Default API response.'

    if (statusCode >= 200 && statusCode < 300) {
        switch (statusCode) {
            case 200: {
                const [method] = routeKey?.split(' ') ?? die("Cannot generate HTTP 200 description without HTTP method.")
                switch (method) {
                    case 'GET':
                        return 'The resource has been fetched and transmitted in the message body.'
                    case 'HEAD':
                        return 'The representation headers are included in the response without any message body.'
                    case 'PUT':
                    case 'POST':
                        return 'The resource describing the result of the action is transmitted in the message body.'
                    case 'TRACE':
                        return 'The message body contains the request message as received by the server.'
                    default:
                        return 'The request succeeded.'
                }
            }
            case 201:
                return 'The request succeeded, and a new resource was created as a result.'
            case 202:
                return 'The request has been received but not yet acted upon.'
            case 204:
                return 'The request succeeded without producing any response.'
            default:
                return 'The request succeeded.'
        }
    } else if (statusCode >= 300 && statusCode < 400) {
        switch (statusCode) {
            case 301:
                return 'The URL of the requested resource has been changed permanently. The new URL is given in the response.'
            case 302:
                return 'The URL of the requested resource has been changed temporarily. The new URL is given in the response.'
            default:
                return 'The request resulted in a redirect.'
        }
    } else if (statusCode >= 400 && statusCode < 500) {
        switch (statusCode) {
            case 400:
                return 'The request failed due to incorrect parameters provided by the client.'
            case 401:
                return 'The request is not authenticated.'
            case 403:
                return 'The request is authenticated but not authorized.'
            case 404:
                return 'Requested resource not found.'
            case 409:
                return 'The request cannot be processed because of the server state.'
            case 429:
                return 'The user has sent too many requests in a given amount of time.'
            default:
                return 'Cannot process the request because of a client error'
        }
    } else if (statusCode >= 500 && statusCode < 600) {
        switch (statusCode) {
            case 500:
                return 'Internal server error.'
            case 503:
                return 'Service is not available (maintenance, overload or other similar temporary condition).'
            default:
                return 'Unexpected server error.'
        }
    } else {
        return ''
    }
}

function makeOperationFromRoute(route: ApiOperation, routeKey: RouteKey) {
    const op: Operation<any> = {}
    for (const key of Object.keys(route)) {
        const prop = key as keyof ApiOperation
        if (route[prop] === undefined) continue
        switch (prop) {
            case 'operationId':
            case 'summary':
            case 'description':
                op[prop] = route[prop]
                break;
            case 'security':
                op[prop] = route[prop]
                break;
            case 'deprecated':
                op[prop] = route[prop]
                break;
            case 'path':
            case 'query':
            case 'headers':
            case 'cookies':
                op[prop] = _.mapValues(route[prop], function (val?: TSchema) {
                    return {
                        description: val?.description,
                        schema: val
                    }
                })
                break;
            case 'body':
                op.body = {
                    description: route.body?.description ?? "Request body",
                    required: !TypeGuard.IsOptional(route.body!),
                    schema: route.body
                }
                break;
            case 'response':
                op.response = _.map(route.response, function (response) {
                    if (typeof response === 'number' || typeof response === "string") {
                        return response
                    }
                    return _.mapValues(response, function (schema, key) {
                        const statusCode = toStatusCode(key)
                        return {
                            schema,
                            description: schema?.description ?? httpStatusDescription(statusCode, routeKey),
                        }
                    })
                })
                break;
        }
    }

    return op
}
