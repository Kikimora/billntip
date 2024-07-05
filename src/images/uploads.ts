import {Conditions as PolicyEntry} from "@aws-sdk/s3-presigned-post/dist-types/types";
import sharp, {FormatEnum} from "sharp";
import {createPresignedPost} from "@aws-sdk/s3-presigned-post";
import {S3} from "@aws-sdk/client-s3";
import _ from "lodash";
import {StreamingBlobPayloadOutputTypes} from "@smithy/types";
import {Type} from "@sinclair/typebox";
import {errorWithContext} from "@app/diagnostics";
import {moduleConfig} from "@app/lambda";

const s3 = new S3()

export const config = moduleConfig()
    .parameters({
        s3: Type.Object({
            bucket: Type.String(),
            cdnRoot: Type.String(),
        })
    })
    .build()

export default {
    prepare: prepareUpload,
    read: readUpload,
    transform: processUpload,
    save: saveUpload,
    remove: deleteUpload,
    list: listUploads
}
type UploadArea = "uploads" | "public"

interface UploadConfig {
    policy: PolicyEntry[],
    expires: number,
    resize: {
        width: number,
        height: number
    },
    format: keyof FormatEnum,
    contentType: string
}

type UploadType = 'profile_pic'

const UploadConfigs: Record<UploadType, UploadConfig> = {
    profile_pic: {
        policy: [
            ["content-length-range", 1024, 5 * 1024 * 1024],
            ["starts-with", "$Content-Type", "image/"],
        ],
        expires: 5 * 60,
        resize: {
            width: 100,
            height: 100
        },
        format: "png",
        contentType: "image/png"
    }
}

function uploadKey(sub: string, id: string, type: UploadArea) {
    return `${type}/${sub}/${id}`;
}

function uploadPrefix(sub: string, type: UploadArea) {
    return `${type}/${sub}`;
}

async function prepareUpload(sub: string, type: UploadType, area: UploadArea) {
    const prefix = uploadPrefix(sub, area)
    const id = type
    const key = uploadKey(sub, id, area)
    const {expires, policy} = UploadConfigs[type]
    const {s3: {bucket}} = await config.parameters
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
        throw errorWithContext(e, "prepareUpload", {bucket, key, config: UploadConfigs[type]})
    }
}

async function listUploads(sub: string, area: UploadArea, lastKey?: string) {
    const {s3: {bucket}} = await config.parameters
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

interface UploadMetadata {
    id: string
    type: UploadType,
    contentType: string
    image?: {
        height: number
        width: number
    }
}

interface Upload extends UploadMetadata {
    url: string
}

async function readUpload(sub: string, id: string, area: UploadArea) {
    const {s3: {bucket, cdnRoot}} = await config.parameters
    const key = uploadKey(sub, id, area)
    try {
        const uploadObject = await s3.getObject({Bucket: bucket, Key: key})
        const type = uploadObject.Metadata?.['type'] as UploadType
        const url = `https://static.${cdnRoot}/${key}`;
        const height = Number(uploadObject.Metadata?.['height'])
        const width = Number(uploadObject.Metadata?.['width'])
        const contentType = uploadObject.ContentType ?? 'application/octet-stream'
        const upload: Upload = {contentType, type, id, url}
        if (!isNaN(height) && !isNaN(width)) {
            upload.image = {width, height}
        }
        return {upload, body: uploadObject.Body}
    } catch (e: any) {
        throw errorWithContext(e, "readUpload", {key})
    }
}

async function processUpload(type: UploadType, body?: StreamingBlobPayloadOutputTypes) {
    try {
        const {format, contentType, resize: {width: targetWidth, height: targetHeight}} = UploadConfigs[type]
        const buffer = await sharp(await body?.transformToByteArray())
            .resize(targetWidth, targetHeight)
            .toFormat(format)
            .toBuffer();
        return {contentType, buffer, format, width: targetWidth, height: targetHeight}
    } catch (e: any) {
        throw errorWithContext(e, "processImage", {type})
    }
}

async function saveUpload(sub: string, buffer: Buffer, upload: UploadMetadata, area: UploadArea) {
    const {id, type, contentType, image} = upload
    const {s3: {bucket, cdnRoot}} = await config.parameters
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
        const url = `https://static.${cdnRoot}/${target}`;
        const metadata: Upload = {
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

async function deleteUpload(sub: string, id: string, type: UploadArea = "public") {
    const {s3: {bucket}} = await config.parameters
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