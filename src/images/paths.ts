import {RouteMap} from "@app/lambda";
import {Type} from "@sinclair/typebox";

const UploadType = Type.Union([
    Type.Literal("profile_pic")
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
    image: Type.Optional(Type.Object({
        width: Type.Number(),
        height: Type.Number(),
        url: Type.String(),
    })),
});
export default {

    'POST /uploads': {
        operationId: "CreateUpload",
        body: Type.Object({
            type: UploadType
        }),
        response: [{200: CreateEmptyImageResponse}]
    },
    'POST /upload/{id}': {
        operationId: "FinishUpload",
        path: {
            id: Type.String()
        },
        response: [{200: Upload}]
    },
    'DELETE /upload/{id}': {
        operationId: "DeleteUpload",
        path: {
            id: Type.String()
        }
    }

} satisfies RouteMap