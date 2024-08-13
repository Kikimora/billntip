import {Conditions as PolicyEntry} from "@aws-sdk/s3-presigned-post/dist-types/types";
import sharp, {FormatEnum} from "sharp";
import {createPresignedPost} from "@aws-sdk/s3-presigned-post";
import {S3} from "@aws-sdk/client-s3";
import _ from "lodash";
import {StreamingBlobPayloadOutputTypes} from "@smithy/types";
import {errorWithContext} from "@app/diagnostics";

const s3 = new S3()

export interface ImageUploaderOptions<T extends string> {
    configs: Record<T, ImageUploadConfig>
    s3: { bucket: string, cdn: string }
}

export default class ImageUploader<Img extends string> {
    readonly configs: Record<Img, ImageUploadConfig>
    readonly s3: { bucket: string; cdn: string; }

    constructor(options: ImageUploaderOptions<Img>) {
        this.configs = options.configs
        this.s3 = options.s3
    }

    async prepare(sub: string, type: Img, area: UploadArea) {
        const {configs, s3: {bucket}} = this
        const prefix = uploadPrefix(sub, area)
        const id = type
        const key = uploadKey(sub, id, area)
        const {expires, policy} = configs[type]
        try {
            const url = await createPresignedPost(s3, {
                Bucket: bucket,
                Key: key,
                Conditions: [
                    {"bucket": bucket},
                    ["starts-with", "$key", prefix],
                    {"x-amz-meta-type": type},
                    ...policy
                ],
                Fields: {key: key},
                Expires: expires
            })

            return {post: url, expires, id}

        } catch (e: any) {
            throw errorWithContext(e, "prepareUpload", {bucket, key, config: configs[type]})
        }
    }

    async read(sub: string, id: string, area: UploadArea) {
        const {s3: {bucket, cdn}} = this
        const key = uploadKey(sub, id, area)
        try {
            const uploadObject = await s3.getObject({Bucket: bucket, Key: key})
            const type = uploadObject.Metadata?.['type'] as Img
            const url = `https://${cdn}/${key}`;
            const height = Number(uploadObject.Metadata?.['height'])
            const width = Number(uploadObject.Metadata?.['width'])
            const contentType = uploadObject.ContentType ?? 'application/octet-stream'
            const upload: Upload<Img> = {contentType, type, id, url}
            if (!isNaN(height) && !isNaN(width)) {
                upload.image = {width, height}
            }
            return {upload, body: uploadObject.Body}
        } catch (e: any) {
            throw errorWithContext(e, "readUpload", {key})
        }
    }

    async list(sub: string, area: UploadArea, lastKey?: string) {
        const {s3: {bucket}} = this
        try {
            const x = await s3.listObjectsV2({
                Bucket: bucket,
                Prefix: uploadPrefix(sub, area),
                ContinuationToken: lastKey,
            })
            const p = uploadPrefix(sub, area)
            return {
                files: _(x.Contents).map('Key').compact().map(x => x.substring(p.length + 1)).value(),
                lastKey: x.ContinuationToken
            }
        } catch (e: any) {
            throw errorWithContext(e, "listUploads", {sub})
        }
    }

    async transform(type: Img, body?: StreamingBlobPayloadOutputTypes) {
        try {
            const {format, contentType, resize: {width: targetWidth, height: targetHeight}} = this.configs[type]
            const buffer = await sharp(await body?.transformToByteArray())
                .resize(targetWidth, targetHeight)
                .toFormat(format)
                .toBuffer();
            return {contentType, buffer, format, width: targetWidth, height: targetHeight}
        } catch (e: any) {
            throw errorWithContext(e, "processImage", {type})
        }
    }

    async save(sub: string, buffer: Buffer, upload: UploadMetadata<Img>, area: UploadArea) {
        const {id, type, contentType, image} = upload
        const {s3: {bucket, cdn}} = this
        const target = uploadKey(sub, id, area);
        try {
            const s3Metadata: Record<string, string> = {'type': type}
            if (image !== undefined) {
                s3Metadata['height'] = image.height.toString()
                s3Metadata['width'] = image.width.toString()
            }
            await s3.putObject({
                Bucket: bucket,
                Key: target,
                ContentType: contentType,
                Metadata: s3Metadata,
                Body: buffer
            })
            const url = `https://${cdn}/${target}`;
            const metadata: Upload<Img> = {
                contentType,
                type,
                id,
                url
            }
            if (image !== undefined) {
                metadata.image = image
            }
            return metadata
        } catch (e: any) {
            throw errorWithContext(e, "saveTransformedImage", {
                buffer: buffer?.subarray(0, 32).toString('hex'),
                length: buffer?.length,
                target,
                contentType
            })
        }
    }

    async remove(sub: string, id: string, type: UploadArea = "public") {
        const {s3: {bucket}} = this
        const key = uploadKey(sub, id, type);
        try {
            await s3.deleteObject({
                Bucket: bucket,
                Key: key
            })
        } catch (e: any) {
            throw errorWithContext(e, "deleteUpload", {key})
        }
    }
}

type UploadArea = "uploads" | "public"

interface ImageUploadConfig {
    policy: PolicyEntry[],
    expires: number,
    resize: {
        width: number,
        height: number
    },
    format: keyof FormatEnum,
    contentType: string
}


function uploadKey(sub: string, id: string, type: UploadArea) {
    return `${type}/${sub}/${id}`;
}

function uploadPrefix(sub: string, type: UploadArea) {
    return `${type}/${sub}`;
}

interface UploadMetadata<T extends string> {
    id: string
    type: T,
    contentType: string
    image?: {
        height: number
        width: number
    }
}

interface Upload<T extends string> extends UploadMetadata<T> {
    url: string
}