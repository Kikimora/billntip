import upath from "upath";
import fs from "fs";
import {IsEqual} from "type-fest";
import _ from "lodash";
import {Handler, HttpMethod, LambdaRequest} from "@app/lambda";
import {Context} from "aws-lambda";
import {APIGatewayEventClientCertificate} from "aws-lambda/common/api-gateway";

export function resources() {
    const o = upath.join(__dirname, "..", "out", `resources.${process.env.TEST_STACK}.json`)
    return JSON.parse(fs.readFileSync(o).toString("utf-8"))
}

export function StaticAssert<T1, T2>() {
    return {
        is() {
        },
    } as { is(x: IsEqual<T1, T2>): void }
}

interface RequestOptions {
    routeKey: string,
    method: HttpMethod
    headers?: Record<string, string>
    cookies?: Record<string, string>
    path?: Record<string, string>
    query?: Record<string, string>
    body?: any
    authorizer?: any
}

export interface TestHandler {
    (options: Partial<RequestOptions>): Promise<any>
}

export function makeTestHandler<T extends Handler>(handler: T, defaults?: RequestOptions) : TestHandler {
    return function (options: Partial<RequestOptions>) {
        options = _.defaults({}, options, defaults)
        const context = {functionName: "Test", functionVersion: "Test"};
        const now = new Date()
        const rawPath = Object.entries(options.path ?? []).reduce(function (path, [key, value]) {
            return path.replace(`{${key}}`, value)
        }, options.routeKey ?? "")
        const cookies = Object.entries(options.cookies ?? {}).map(([k, v]) => `${k}=${v}`)
        const rawQueryString = Object.entries(options.query ?? {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
        const event: LambdaRequest = {
            version: "2.0",
            isBase64Encoded: false,
            routeKey: options.routeKey ?? "",
            rawPath,
            pathParameters: options.path,
            cookies: cookies.length > 0 ? cookies : undefined,
            headers: options.headers ?? {},
            queryStringParameters: options.query,
            rawQueryString,
            body: options.body,
            requestContext: {

                authorizer: options.authorizer,

                accountId: "123",
                apiId: "345",
                authentication: {
                    clientCert: undefined
                },
                domainName: "test",
                domainPrefix: "",
                http: {
                    method: options.method,
                    path: rawPath,
                    protocol: "https",
                    sourceIp: "127.0.0.1",
                    userAgent: "Test Browser"
                },
                requestId: "TEST REQUEST",
                routeKey: options.routeKey,
                stage: "TEST",
                time: now.toString(),
                timeEpoch: now.getTime() / 1000

            } as any,
        }
        return handler(event, context as any)
    }
}

export class RequestBuilder {

    constructor(context: Partial<Context>) {
        this.context = context
    }

    public readonly event: any = {}
    public readonly context: any = {}

    run<T extends Handler>(handler: T) {
        return handler(this.event, this.context)
    }

    build() {
        return [this.event, this.context]
    }

    route(key: string, params?: Record<string, string>) {
        _.merge(this.event, {
            routeKey: key,
            pathParameters: params
        })
        return this
    }

    lambdaAuth(lambda: object) {
        _.merge(this.event, {
            requestContext: {
                authorizer: {
                    lambda
                }
            }
        })
        return this
    }

    jsonBody(body: any) {
        _.merge(this.event, {
            body: JSON.stringify(body),
            headers: {
                'content-type': 'application/json'
            }
        })
        return this
    }
}
