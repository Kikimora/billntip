import _ from "lodash";
import {S3} from "@aws-sdk/client-s3";
import {Static, Type} from "@sinclair/typebox";
import {LRUCache} from "lru-cache";

const s3 = new S3()

export const TemplateRepoOptions = Type.Object({
    bucket: Type.String(),
    prefix: Type.Optional(Type.String()),
    cache: Type.Optional(Type.Boolean()),
})

export type TemplateRepoOptions = Static<typeof TemplateRepoOptions>

export interface Template {
    body: _.TemplateExecutor
    metadata: Record<string, string>
}

export class TemplateRepo {
    bucket: string
    prefix: string
    _cache?: LRUCache<string, Template>

    constructor(options: TemplateRepoOptions) {
        this.bucket = options.bucket
        this.prefix = options.prefix ?? "templates"
        const cache = options.cache ?? true
        if (cache) {
            this._cache = new LRUCache({
                ttl: 300,
                ttlAutopurge: false,
                max: 1000
            })
        }
    }

    async fetchTemplate(name: string) {
        if (this._cache !== undefined) {
            let template = this._cache.get(name)
            if (template === undefined) {
                template = await fetchTemplate(this.bucket, this.prefix)
            }
            this._cache.set(name, template)
            return template
        } else {
            return await fetchTemplate(this.bucket, this.prefix)
        }

        async function fetchTemplate(bucket: string, prefix: string) {
            const {Body: body, Metadata: metadata} = await s3.getObject({
                Bucket: bucket,
                Key: _([prefix, name]).compact().join('/')
            })
            const templateBody = await body?.transformToString()
            return {body: _.template(templateBody), metadata: metadata ?? {}}
        }
    }
}