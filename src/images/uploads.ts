import shortUUID from "short-uuid";
import {Conditions as PolicyEntry} from "@aws-sdk/s3-presigned-post/dist-types/types";
import sharp, {FormatEnum} from "sharp";
import {createPresignedPost} from "@aws-sdk/s3-presigned-post";
import {GetObjectCommandOutput, S3} from "@aws-sdk/client-s3";
import {withErrorContext} from "@app/diagnostics";
import {die} from "@app/util";

const Bucket = process.env.BUCKET ?? die("BUCKET required")
const Region = process.env.AWS_REGION ?? die("AWS_REGION required")

const shortUUIDGenerator = shortUUID(shortUUID.constants.flickrBase58)
const s3 = new S3()

export default {
    prepare: prepareUpload,
    read: readUpload,
    process: processUpload,
    save: saveUpload,
    remove: deleteUpload,
    Bucket,
    Region
}

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

function uploadKey(sub: string, id: string) {
    return `uploads/${sub}/${id}`;
}

function uploadPrefix(sub: string) {
    return `uploads/${sub}`;
}

async function prepareUpload(sub: string, type: UploadType) {
    const prefix = uploadPrefix(sub)
    const id = shortUUIDGenerator.generate()
    const key = uploadKey(sub, id)
    const {expires, policy} = UploadConfigs[type]
    try {
        const url = await createPresignedPost(s3, {
            Bucket,
            Key: key,
            Conditions: [
                {"bucket": Bucket},
                ["starts-with", "$key", prefix],
                {"x-amz-meta-type": type},
                ...policy
            ],
            Fields: {key: key},
            Expires: expires
        })

        return {post: url, expires, id}

    } catch (e: any) {
        throw withErrorContext(e, "prepareUpload", {Bucket, key, config: UploadConfigs[type]})
    }
}

async function readUpload(sub: string, id: string) {
    const key = uploadKey(sub, id)
    try {
        const uploadObject = await s3.getObject({Bucket, Key: key})
        const type = uploadObject.Metadata?.['type'] as UploadType
        if (type === undefined) throw new Error("Cannot process upload without a type")
        if (type !== "profile_pic") throw new Error("Unexpected upload type")
        return {uploadObject, type}
    } catch (e: any) {
        throw withErrorContext(e, "readUpload", {key})
    }
}

async function processUpload(type: UploadType, s3Object: GetObjectCommandOutput) {
    try {
        const {format, contentType, resize: {width: targetWidth, height: targetHeight}} = UploadConfigs[type]
        const buffer = await sharp(await s3Object.Body?.transformToByteArray())
            .resize(targetWidth, targetHeight)
            .toFormat(format)
            .toBuffer();
        return {contentType, buffer, width: targetWidth, height: targetHeight}
    } catch (e: any) {
        const {Body, ...rest} = s3Object
        throw withErrorContext(e, "processImage", {type, s3Object: rest})
    }
}

async function saveUpload(buffer: Buffer, sub: string, type: UploadType) {
    const {format, contentType} = UploadConfigs[type]
    const target = `public/${sub}/${type}.${format}`;
    try {
        const x = await s3.putObject({
            Bucket,
            Key: target,
            ContentType: contentType,
            Metadata: {
                'x-amz-meta-type': type
            },
            Body: buffer
        })
        return target
    } catch (e: any) {
        throw withErrorContext(e, "saveTransformedImage", {
            buffer: buffer?.subarray(0, 32).toString('hex'),
            length: buffer?.length,
            target,
            contentType
        })
    }
}

async function deleteUpload(sub: string, id: string) {
    const key = uploadKey(sub, id);
    try {
        await s3.deleteObject({
            Bucket,
            Key: key
        })
    } catch (e: any) {
        throw withErrorContext(e, "deleteUpload", {key})
    }
}