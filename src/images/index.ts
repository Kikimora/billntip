import {Static, Type} from "@sinclair/typebox";
import {badRequestError, internalError, bootstrap, pipeline} from "@app/lambda";
import {SessionContextSchema} from "@src/authorizer/operation";
import {S3Object} from "@src/object-store"
import Paths from "./paths";
import ImageUploader from "./uploads"
import sharp, {FormatEnum} from "sharp";
import {StreamingBlobPayloadOutputTypes} from "@smithy/types";

export const Module = bootstrap()
    .parameters({
        s3: Type.Object({
            bucket: Type.String(),
            cdn: Type.String(),
            tmpPrefix: Type.Optional(Type.String({default:"/tmp"})),
            publicPrefix: Type.Optional(Type.String({default:"/public/static"})),
            originalsPrefix: Type.Optional(Type.String({default:"/uploads"})),
        })
    })
    .buildModule(function ({s3}) {
        const uploads = new ImageUploader({
            configs: {
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
                },
                location_pic: {
                    policy: [
                        ["content-length-range", 1024, 5 * 1024 * 1024],
                        ["starts-with", "$Content-Type", "image/"],
                    ],
                    expires: 5 * 60,
                    resize: {
                        width: 100,
                        height: 100
                    },
                    format: "jpeg",
                    contentType: "image/jpeg"
                }
            },
            s3
        })
        return {uploads, s3}
    })

export async function __init() {
    return Module.exports
}

interface ImageTransform {
    resize: {
        width: number,
        height: number
    },
    format: keyof FormatEnum
}

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .requireLambdaAuth(SessionContextSchema)
    .parseJsonBody()
    .withRoutes(Paths)
    .done(async function (req) {
        const {uploads, s3} = await __init()
        //TODO: owner can be user or organisation.
        const owner = req.principal.id_token_json.sub
        switch (req.routeKey) {

            case 'POST /images': {
                const {body: {key}} = req.parse()
                const src = new S3Object(s3.bucket, key)
                let {body, metadata} = await src.read()
                let {transform, destination, ...props} = metadata.props

                if (destination === undefined) {
                    if (s3.tmpPrefix !== undefined && key.startsWith(s3.tmpPrefix)) {
                        destination = key.substring(s3.tmpPrefix.length + 1)
                    } else {
                        destination = key
                    }
                }

                //TODO - check uploaded data with an anti-virus
                //TODO - confirm uploaded data is of the expected format

                //If no transform specified then move image to the destination
                if (transform === undefined) {
                    await src.move(`${s3.publicPrefix}/${destination}`, {props})
                    return {
                        content_type: metadata.contentType,
                        key: destination,
                        url: `https://${s3.cdn}/${destination}`
                    } satisfies Static<typeof req.route.success>
                }

                //Generate image applying requested transformation(s)
                let image: Awaited<ReturnType<typeof transformImage>>
                switch (transform) {
                    case 'resize': {
                        const {
                            'target-width': targetWidth,
                            'target-height': targetHeight,
                            'target-format': targetFormat,
                            ...rest
                        } = props
                        const width = Number(targetWidth)
                        const height = Number(targetHeight)
                        const format = targetFormat as keyof FormatEnum
                        image = await transformImage(body, {
                            format,
                            resize: {
                                width, height
                            }
                        })
                        props = rest
                        break
                    }
                    default:
                        throw badRequestError("Unexpected image transformation type").withContext("POST /images", {
                            key: src.key,
                            bucket: src.bucket,
                            metadata
                        })
                }

                //1. Save generated image(s) into prefix accessible by the CDN.
                //2. Save original image into originals folder if configured.
                const dst = new S3Object(s3.bucket, `${s3.publicPrefix}/${destination}`)
                const saveOriginal = s3.originalsPrefix !== undefined;
                if (saveOriginal) {
                    props.original = key
                }

                await dst.put(image.buffer, {
                    contentType: image.contentType,
                    props: {
                        ...props,
                        "width": String(image.width),
                        "height": String(image.height),
                    }
                })

                if (saveOriginal) {
                    await src.move(`${s3.originalsPrefix}/${destination}`)
                } else {
                    await src.delete()
                }

                return {
                    content_type: image.contentType,
                    key: destination,
                    url: `https://${s3.cdn}/${destination}`,
                    image: {
                        height: image.height,
                        width: image.width
                    }
                } satisfies Static<typeof req.route.success>
            }

            case 'GET /uploads': {
                const {query: {startKey}} = req.parse()
                const {files, lastKey} = await uploads.list(owner, "public", startKey)
                return {
                    lastKey,
                    files
                } satisfies Static<typeof req.route.success>
            }
            case 'GET /upload/{id}': {
                const {path: {id}} = req.parse()
                const {upload} = await uploads.read(owner, id, "public")
                return upload satisfies Static<typeof req.route.success>
            }
            case 'POST /uploads': {
                const {body: {type}} = req.parse()
                const {post, expires, id} = await uploads.prepare(owner, type, "uploads")
                return {
                    type,
                    id: id,
                    uploadUrl: post.url,
                    uploadFields: post.fields,
                    expires: new Date(Date.now() + expires * 1000)
                } satisfies Static<typeof req.route.success>
            }
            case 'POST /upload/{id}': {
                const {path: {id}} = req.parse()
                //invalidate CloudFront cache ???
                const {upload, body} = await uploads.read(owner, id, "uploads")
                const {buffer, format, contentType, width, height} = await uploads.transform(upload.type, body)
                const newUpload = {
                    ...upload,
                    id: `${upload.type}.${format}`,
                    contentType,
                    image: {
                        width, height
                    }
                }
                return await uploads.save(owner, buffer, newUpload, "public") satisfies Static<typeof req.route.success>
            }
            case 'DELETE /upload/{id}': {
                const {path: {id}} = req.parse()
                await uploads.remove(owner, id, "public")
                return {
                    statusCode: 200
                }
            }
        }

        async function transformImage(body: StreamingBlobPayloadOutputTypes, config: ImageTransform) {
            try {
                const {format, resize: {width: targetWidth, height: targetHeight}} = config
                const buffer = await sharp(await body.transformToByteArray())
                    .resize(targetWidth, targetHeight)
                    .toFormat(format)
                    .toBuffer();
                return {contentType: `image/${format}`, buffer, format, width: targetWidth, height: targetHeight}
            } catch (e: any) {
                throw internalError("Unexpected error transforming image").withContext("transformImage", {
                    cause: e,
                    config
                })
            }
        }
    })
