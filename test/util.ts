import upath from "upath";
import fs from "fs";
import {IsEqual} from "type-fest";
import {Context} from "aws-lambda";
import _ from "lodash";

export function resources() {
    const o = upath.join(__dirname, "..", "aws", "resources.json")
    return JSON.parse(fs.readFileSync(o).toString("utf-8"))
}

export function StaticAssert<T1, T2>() {
    return {
        is() {
        },
    } as { is(x: IsEqual<T1, T2>): void }
}

export class RequestBuilder {

    constructor(context: Partial<Context>) {
        this.context = context
    }

    public readonly event: any = {}
    public readonly context: any = {}

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

    json(body: any) {
        _.merge(this.event, {
            body: JSON.stringify(body),
            headers: {
                'content-type': 'application/json'
            }
        })
        return this
    }
}
