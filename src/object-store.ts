import {
    CopyObjectCommandInput,
    GetObjectCommandOutput,
    HeadObjectCommandOutput,
    PutObjectCommandInput,
    S3
} from "@aws-sdk/client-s3";
import {createPresignedPost} from "@aws-sdk/s3-presigned-post";
import {StreamingBlobPayloadOutputTypes} from "@smithy/types";
import {badRequestError, internalError, notFoundError} from "@app/lambda";
import _ from "lodash";
import type {Readable} from "stream";
import {CopyObjectResult, DeleteObjectRequest} from "@aws-sdk/client-s3/dist-types/models/models_0";
import {die} from "@app/util";
import {Static, Type} from "@sinclair/typebox";

/**
 * Prepared upload destination URL and upload parameters.
 */
export interface UploadDestination {
    /**
     * Destination key.
     */
    key: string
    /**
     * Upload destination area.
     */
    area: Area,
    /**
     * URL where uploaded data will be available after upload process completes.
     */
    url: string
    /**
     * Upload POST url
     */
    uploadUrl: string
    /**
     * Upload URL parameters.
     */
    uploadFields: Record<string, string>
    /**
     * Upload expiration date.
     */
    expires: Date
}

export type Area = "public" | "staging"

/**
 * Object checksum.
 */
interface S3ObjectChecksum {
    /**
     * Checksum algorithm.
     */
    type: "CRC32" | "CRC32C" | "SHA1" | "SHA256"
    /**
     * Base64 encoded checksum value.
     */
    value: string
}

interface S3ObjectCommonMetadata {
    /**
     * Object content type.
     */
    contentType: string
    /**
     * Specifies caching behavior along the request/ reply chain.
     */
    cacheControl?: string
    /**
     * Object storage class.
     */
    storageClass: "DEEP_ARCHIVE" | "EXPRESS_ONEZONE" | "GLACIER" | "GLACIER_IR" | "INTELLIGENT_TIERING" | "ONEZONE_IA" | "OUTPOSTS" | "REDUCED_REDUNDANCY" | "SNOW" | "STANDARD" | "STANDARD_IA"
    /**
     * Object content encodings in the order in which they were applied.
     */
    encoding?: string[]
    /**
     * Object language.
     */
    lang?: string
    /**
     * Object content disposition.
     */
    disposition: string
}

interface S3PutOptions extends Partial<S3ObjectCommonMetadata> {
    /**
     * Custom object properties.
     */
    props?: Record<string, string>
    /**
     * Size of the body in bytes. This parameter is useful when the size of the body cannot be determined automatically.
     */
    length?: number
    /**
     * Object checksum.
     */
    checksum?: S3ObjectChecksum
    /**
     * The base64-encoded 128-bit MD5 digest of the message (without the headers) according to RFC 1864.
     */
    contentMD5?: string
    /**
     * The date and time at which the object is no longer cacheable.
     */
    expires?: Date
}

interface S3CopyOptions extends Partial<S3ObjectCommonMetadata> {
    /**
     * Custom object properties to replace target's properties.
     */
    props?: Record<string, string>
    /**
     * The date and time at which the object is no longer cacheable.
     */
    expires?: Date
    /**
     * Algorithm to create the checksum for the object.
     */
    checksum?: S3ObjectChecksum['type']
    /**
     * Copies the object if its entity tag (ETag) matches the specified tag.
     */
    ifMatch?: string
    /**
     * Copies the object if its entity tag (ETag) is different than the specified ETag.
     */
    ifNoneMatch?: string
    /**
     * Copies the object if it has been modified since the specified time.
     */
    ifModifiedSince?: Date
    /**
     * Copies the object if it hasn't been modified since the specified time.
     */
    ifUnmodifiedSince?: Date
}

interface S3DeleteOptions {
    /**
     * Version ID used to reference a specific version of the object.
     */
    versionId?: string
}


interface S3ReadOptions {
    /**
     * For read operation this option request to download the specified byte range of an object.
     * For head operation this option request the length of the part. If the Range is not satisfiable, S3 returns a 416 - Requested Range Not Satisfiable error.
     */
    range?: string;
    /**
     * Return the object only if it has not been modified since the specified time; otherwise, return a 412 (precondition failed) error.
     */
    ifUnmodifiedSince?: Date;
    /**
     * Return the object only if its entity tag (ETag) is different from the one specified; otherwise, return a 304 (not modified) error.
     */
    ifNoneMatch?: string;
    /**
     * Return the object only if it has been modified since the specified time; otherwise, return a 304 (not modified) error.
     */
    ifModifiedSince?: Date;
    /**
     * Return the object only if its entity tag (ETag) is the same as the one specified; otherwise, return a 412 (precondition failed) error.
     */
    ifMatch?: string;
    /**
     * Version ID used to reference a specific version of the object.
     */
    versionId?: string
    /**
     * To retrieve the checksum, this parameter must be enabled.
     */
    checksum?: boolean
    /**
     * Part number of the object being read. This is a positive integer between 1 and 10,000.
     */
    partNumber?: number
    /**
     * Force read, default is false allowing use of in-memory cached data.
     */
    force?: boolean
}


interface S3BObjectMetadata extends S3ObjectCommonMetadata {
    /**
     * Size of the body in bytes.
     */
    length: number
    /**
     * Custom object properties.
     */
    props: Record<string, string>
    /**
     * Object checksum.
     */
    checksum?: S3ObjectChecksum
    /**
     * Object's entity tag (ETag) calculated by the storage.
     */
    etag?: string
    /**
     * The date and time at which the object is no longer cacheable.
     */
    expires?: string
    /**
     * Creation date of the object.
     */
    createdAt: Date,
    /**
     * Version ID used to reference a specific version of the object.
     */
    versionId: string
}

const defaultS3 = new S3()
const emptyObject = Object.freeze({})
type S3ObjectBodyContent = string | Uint8Array | Buffer | Readable;

interface S3ObjectContent {
    metadata: S3BObjectMetadata
    body: StreamingBlobPayloadOutputTypes
}

export class S3Object {

    private _head?: S3BObjectMetadata
    private _body?: StreamingBlobPayloadOutputTypes;

    constructor(public readonly bucket: string,
                public readonly key: string,
                public readonly s3: S3 = defaultS3) {
    }

    get metadata(): Readonly<S3BObjectMetadata> | undefined {
        return this._head
    }

    get body(): Readonly<StreamingBlobPayloadOutputTypes> | undefined {
        return this._body
    }

    get keyExt() {
        const path = this.key.split('/');
        const fname = path[path.length - 1]
        if (fname === undefined) return ""
        const parts = fname.split(".")
        return parts[parts.length - 1] ?? ""
    }

    private async _headObject(options?: S3ReadOptions): Promise<Readonly<S3BObjectMetadata>> {
        options = options ?? emptyObject
        let {force} = options
        force = force ?? false
        if (!force && this._head !== undefined) return this._head

        const {s3, bucket, key} = this
        try {
            let head = await s3.headObject({
                Bucket: bucket,
                Key: key,
                VersionId: options.versionId,
                ChecksumMode: options.checksum ? "ENABLED" : undefined,
                IfMatch: options.ifMatch,
                IfModifiedSince: options.ifModifiedSince,
                IfNoneMatch: options.ifNoneMatch,
                IfUnmodifiedSince: options.ifUnmodifiedSince,
                PartNumber: options.partNumber,
                Range: options.range
            })
            this._head = this.toMetadata(head);
            return this._head
        } catch (error: any) {
            throw this.toRequestError(error).withContext("head", {bucket, key, cause: error});
        }
    }

    head(options?: S3ReadOptions): NothingPromise<Readonly<S3BObjectMetadata>> {
        let task = this._headObject(options)
        addReturnNothingIfNotFound(task)
        return task
    }

    async _read(options?: S3ReadOptions): Promise<S3ObjectContent> {
        options = options ?? emptyObject
        let {force} = options
        force = force ?? false
        if (!force && this._body !== undefined && this._head !== undefined)
            return {body: this._body, metadata: this._head}

        const {s3, bucket, key} = this

        try {
            let obj = await s3.getObject({
                Bucket: bucket,
                Key: key,
                VersionId: options.versionId,
                ChecksumMode: options.checksum ? "ENABLED" : undefined,
                IfMatch: options.ifMatch,
                IfModifiedSince: options.ifModifiedSince,
                IfNoneMatch: options.ifNoneMatch,
                IfUnmodifiedSince: options.ifUnmodifiedSince,
                PartNumber: options.partNumber,
                Range: options.range
            })
            this._head = this.toMetadata(obj)
            this._body = obj.Body ?? die(internalError("Unexpected error: object does not have body"))
            return {body: this._body, metadata: this._head}
        } catch (error: any) {
            throw this.toRequestError(error).withContext("read", {bucket, key, cause: error});
        }
    }

    read(options?: S3ReadOptions): NothingPromise<S3ObjectContent> {
        let task = this._read(options)
        addReturnNothingIfNotFound(task)
        return task
    }

    async put(body: S3ObjectBodyContent, options?: S3PutOptions) {
        const {s3, bucket, key} = this
        try {
            const command: PutObjectCommandInput = {
                Body: body,
                Bucket: bucket,
                Key: key,
            }
            if (options !== undefined) {
                command.ContentLength = options.length
                command.ContentMD5 = options.contentMD5
                if (options.checksum !== undefined) {
                    command.ChecksumAlgorithm = options.checksum.type
                    switch (options.checksum.type) {
                        case 'CRC32':
                            command.ChecksumCRC32 = options.checksum.value
                            break
                        case 'CRC32C':
                            command.ChecksumCRC32C = options.checksum.value
                            break
                        case 'SHA1':
                            command.ChecksumSHA1 = options.checksum.value
                            break
                        case 'SHA256':
                            command.ChecksumSHA256 = options.checksum.value
                            break
                    }
                }

                command.ContentType = options.contentType ?? "application/octet-stream"
                command.ContentEncoding = options.encoding?.join(",")
                command.ContentLanguage = options.lang
                command.CacheControl = options.cacheControl
                command.Expires = options.expires
                command.Metadata = options.props === emptyObject ? undefined : options.props
                command.StorageClass = options.storageClass ?? "STANDARD"
                command.ContentDisposition = options.disposition
            }
            let obj = await s3.putObject(command)
            this._head = undefined
            this._body = undefined
            return obj.ETag ?? ""
        } catch (error: any) {
            throw this.toRequestError(error).withContext("put", {bucket, key, cause: error});
        }
    }

    async copy(targetKey: string, options?: S3CopyOptions): Promise<S3Object> {
        const {s3, bucket, key} = this
        try {
            const command: CopyObjectCommandInput = {
                Bucket: bucket,
                Key: targetKey,
                CopySource: `${bucket}/${key}`,
            }
            if (options !== undefined) {
                command.ChecksumAlgorithm = options.checksum
                command.CopySourceIfMatch = options.ifMatch
                command.CopySourceIfModifiedSince = options.ifModifiedSince
                command.CopySourceIfNoneMatch = options.ifNoneMatch
                command.CopySourceIfUnmodifiedSince = options.ifUnmodifiedSince
                command.MetadataDirective = options.props === undefined ? "COPY" : "REPLACE"

                command.ContentType = options.contentType ?? "application/octet-stream"
                command.ContentEncoding = options.encoding?.join(",")
                command.ContentLanguage = options.lang
                command.CacheControl = options.cacheControl
                command.Expires = options.expires
                command.Metadata = options.props
                command.StorageClass = options.storageClass ?? "STANDARD"
                command.ContentDisposition = options.disposition
            }

            let {CopyObjectResult: copyResult} = await s3.copyObject(command)
            let head = undefined
            if (this._head !== undefined && copyResult !== undefined) {
                head = {
                    ...this._head,
                }
                head.createdAt = copyResult.LastModified ?? this._head.createdAt
                head.checksum = this.makeChecksum(copyResult)
            }
            const s3Object = new S3Object(bucket, targetKey, s3);
            s3Object._head = head
            s3Object._body = this._body
            return s3Object
        } catch (error: any) {
            throw this.toRequestError(error).withContext("copy", {bucket, key, cause: error});
        }
    }

    async move(targetKey: string, options?: S3CopyOptions): Promise<S3Object> {
        const moved = await this.copy(targetKey, options)
        await this.delete().catch(/*Ignore errors*/)
        return moved
    }

    async delete(options?: S3DeleteOptions) {
        const {s3, bucket, key} = this
        try {
            const command: DeleteObjectRequest = {
                Bucket: bucket,
                Key: key
            }
            if (options !== undefined) {
                command.VersionId = options.versionId
            }
            await s3.deleteObject(command)
        } catch (error: any) {
            throw this.toRequestError(error).withContext("delete", {bucket, key, cause: error});
        }
    }

    private toRequestError(error: any) {
        switch (error.name) {
            case 'InvalidRange':
            case 'PreconditionFailed':
                return badRequestError(error.message)
            case 'NotFound':
                return notFoundError(error.message)
            case 'InternalServerError':
                return error
            default:
                return internalError("Unexpected error from the object store")
        }
    }

    private toMetadata(head: HeadObjectCommandOutput | GetObjectCommandOutput) {
        let _head: S3BObjectMetadata = {
            contentType: head.ContentType ?? "application/octet-stream",
            encoding: head.ContentEncoding?.split(","),
            lang: head.ContentLanguage,
            length: head.ContentLength ?? 0,
            etag: head.ETag,
            expires: head.ExpiresString,
            createdAt: head.LastModified ?? new Date(0),
            props: head.Metadata ?? emptyObject,
            storageClass: head.StorageClass ?? "STANDARD",
            versionId: head.VersionId ?? "0",
            disposition: head.ContentDisposition ?? "inline",
            cacheControl: head.CacheControl
        }
        _head.checksum = this.makeChecksum(head)
        return Object.freeze(_head);
    }

    private makeChecksum(head: HeadObjectCommandOutput | GetObjectCommandOutput | CopyObjectResult): S3ObjectChecksum | undefined {
        if (head.ChecksumCRC32 !== undefined) {
            return {
                type: "CRC32",
                value: head.ChecksumCRC32
            }
        }
        if (head.ChecksumCRC32C !== undefined) {
            return {
                type: "CRC32C",
                value: head.ChecksumCRC32C
            }
        }
        if (head.ChecksumSHA1 !== undefined) {
            return {
                type: "SHA1",
                value: head.ChecksumSHA1
            }
        }
        if (head.ChecksumSHA256 !== undefined) {
            return {
                type: "SHA256",
                value: head.ChecksumSHA256
            }
        }
        return undefined
    }
}

type EqualCondition = ["eq", string, string] | Record<string, string>;
type StartsWithCondition = ["starts-with", string, string];
type ContentLengthRangeCondition = ["content-length-range", number, number];
export type UploadCondition = EqualCondition | StartsWithCondition | ContentLengthRangeCondition;

export const Upload = Type.Object({
    url: Type.String(),
    fields: Type.Record(Type.String(), Type.String())
})

export type Upload = Static<typeof Upload>

/**
 * A path-like string optionally ending with ${filename} marker. The marker (if present) replaced with the uploaded
 * file name taken from the Content-Disposition: filename part.
 */
type UploadKey = string

interface UploadBuilderOptions {
    bucket: string
    prefix: string
    s3?: S3
}

export function uploadBuilder(key: string, options: UploadBuilderOptions) {
    return new UploadBuilder(key, options)
}

export async function uploadBuffer(upload: Upload, content: Buffer) {
    const formData = new FormData();
    Object.entries(upload.fields).forEach(([k, v]) => {
        formData.append(k, v);
    });
    formData.append("Content-Type", "image/jpeg");
    //use blob to upload data, simple call like
    //formData.append("file", imageBuffer);
    //does upload but result in a garbage bytes written to the S3 object.
    const blob = new Blob([content], {type: "image/jpeg"})
    formData.append("file", blob, 'image.jpeg');
    return await fetch(upload.url, {method: "POST", body: formData})
}

export class UploadBuilder {

    private _expires?: number;
    private _fields?: Record<string, string>;
    private _conditions?: UploadCondition[];
    private bucket: string
    private prefix: string
    private s3: S3

    constructor(public readonly key: UploadKey,
                options: UploadBuilderOptions) {
        this.bucket = options.bucket
        this.prefix = options.prefix
        this.s3 = options.s3 ?? defaultS3
    }

    toJSON() {
        return {
            expires: this._expires,
            conditions: this._conditions,
            fields: this._fields,
            bucket: this.bucket,
            prefix: this.prefix,
            key: this.key
        }
    }

    expires(date: number) {
        this._expires = date
        return this
    }

    properties(f: Record<string, string>) {
        this._fields = _.merge(this._fields, _.mapKeys(f, function (_v, k) {
            return 'x-amz-meta-' + k
        }))
        return this
    }

    condition(condition: UploadCondition) {
        this._conditions = this._conditions ?? []
        this._conditions.push(condition)
        return this
    }

    async build(): Promise<Upload> {
        const {s3, bucket, prefix} = this
        const s3Key = `${prefix}/${this.key}`
        const options = {
            Bucket: bucket,
            Key: s3Key,
            Conditions: this._conditions,
            Expires: this._expires,
            Fields: this._fields
        };
        try {
            return await createPresignedPost(s3, options)
        } catch (e: any) {
            throw internalError("Unexpected error creating upload").withContext("build", {options})
        }
    }
}

type ReturnNothing<T> = { returnNothingIfNotFound(): Promise<T | undefined> }
type NothingPromise<T> = Promise<T> & ReturnNothing<T>

async function returnNothingIfNotFound<T>(this: Promise<T>) {
    try {
        return await this;
    } catch (e: any) {
        if (e.statusCode === "404") return undefined
        throw e
    }
}

function addReturnNothingIfNotFound<T>(p: Promise<T> & Partial<ReturnNothing<T>>): asserts p is NothingPromise<T> {
    p.returnNothingIfNotFound = returnNothingIfNotFound
}