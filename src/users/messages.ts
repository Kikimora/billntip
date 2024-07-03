import _ from "lodash";
import {S3} from "@aws-sdk/client-s3";

const s3 = new S3()

export interface S3Options {
    s3: { bucket?: string }
}
export type FetchTemplateOptions = S3Options

export async function fetchTemplate(template: string, options?: FetchTemplateOptions) {
    options = options ?? fetchTemplate.defaults
    const {Body: body} = await s3.getObject({
        Bucket: options.s3.bucket,
        Key: `emails/${template}/template.html`
    })
    const templateBody = await body?.transformToString()
    return _.template(templateBody)
}

fetchTemplate.defaults = {s3: { bucket: undefined }} as FetchTemplateOptions