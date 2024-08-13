import {RouteMap} from "@app/lambda";
import {Type} from "@sinclair/typebox";

const UploadType = Type.Union([
    Type.Literal("profile_pic"),
    Type.Literal("location_pic"),
])

export const CreateEmptyImageResponse = Type.Object({
    id: Type.String(),
    type: UploadType,
    uploadUrl: Type.String(),
    uploadFields: Type.Record(Type.String(), Type.String()),
    expires: Type.Date()
});
export const Upload = Type.Object({
    id: Type.String(),
    type: UploadType,
    contentType: Type.String(),
    url: Type.String(),
    image: Type.Optional(Type.Object({
        width: Type.Number(),
        height: Type.Number(),
    })),
});
export const Upload2 = Type.Object({
    url: Type.String(),
    key: Type.String(),
    content_type: Type.String(),
    image: Type.Optional(Type.Object({
        width: Type.Number(),
        height: Type.Number(),
    })),
});

export default {
    'POST /images': {
        operationId: "POST /images",
        body: Type.Object({
            key: Type.String({description: "Upload key"})
        }),
        success: Upload2
    },

    'GET /uploads': {
        operationId: "ListUploads",
        query: {
            startKey: Type.Optional(Type.String({maxLength: 1024}))
        },
        success: Type.Object({
            lastKey: Type.Optional(Type.String()),
            files: Type.Array(Type.String())
        }),
        responses: [400, 401, 403]
    },
    'GET /upload/{id}': {
        operationId: "ListUploads",
        path: {
            id: Type.String({maxLength: 1024})
        },
        success: Upload,
        responses: [400, 401, 403]
    },
    'POST /uploads': {
        operationId: "CreateUpload",
        body: Type.Object({
            type: UploadType
        }),
        success: CreateEmptyImageResponse,
        responses: [400, 401, 403]
    },
    'POST /upload/{id}': {
        operationId: "FinishUpload",
        path: {
            id: Type.String({maxLength: 1024})
        },
        success: Upload,
        responses: [400, 401, 403, 404]
    },
    'DELETE /upload/{id}': {
        operationId: "DeleteUpload",
        path: {
            id: Type.String({maxLength: 1024})
        },
        responses: [400, 401, 403, 404]
    }

} satisfies RouteMap