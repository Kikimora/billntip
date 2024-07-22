import {Static, Type} from "@sinclair/typebox";
import {moduleConfig, pipeline} from "@app/lambda";
import {SessionContextSchema} from "@src/authorizer/operation";
import Paths, {CreateEmptyImageResponse} from "./paths";
import ImageUploader from "./uploads"

export type CreateUploadResponse = Static<typeof CreateEmptyImageResponse>

export const config = moduleConfig()
    .parameters({
        s3: Type.Object({
            bucket: Type.String(),
            cdnRoot: Type.String(),
        })
    })
    .build()

export async function __init() {

    return config.parameters.then(function ({s3}) {
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
                }
            },
            s3
        })
        return {uploads, s3}
    })
}

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .requireLambdaAuth(SessionContextSchema)
    .parseJsonBody()
    .withRoutes(Paths)
    .done(async function (req) {
        const {uploads} = await __init()
        //TODO: owner can be user or organisation.
        const owner = req.principal.id_token_json.sub
        switch (req.routeKey) {
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
                    type: "profile_pic",
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
    })
