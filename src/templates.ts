import _ from "lodash";
import {S3} from "@aws-sdk/client-s3";
import {Static, Type} from "@sinclair/typebox";
import {LRUCache} from "lru-cache";

const s3 = new S3()

export const TemplateRepoOptions = Type.Object({
    bucket: Type.String(),
    prefix: Type.Optional(Type.String()),
})

export type TemplateRepoOptions = Static<typeof TemplateRepoOptions>

export class TemplateRepo {
    bucket: string
    prefix: string
    _cache: LRUCache<string, _.TemplateExecutor>

    constructor(options: TemplateRepoOptions) {
        this.bucket = options.bucket
        this.prefix = options.prefix ?? "templates"
        this._cache = new LRUCache({
            ttl: 300,
            ttlAutopurge: false,
            max: 1000
        })
    }

    async fetchTemplate(name: string) {
        let template = this._cache.get(name)
        if (template === undefined) {
            const {Body: body} = await s3.getObject({
                Bucket: this.bucket,
                Key: _([this.prefix, name]).compact().join('/')
            })
            const templateBody = await body?.transformToString()
            template = _.template(templateBody)
        }
        this._cache.set(name, template)
        return template
    }
}