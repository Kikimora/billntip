import {Type as T} from '@sinclair/typebox';
import {RouteMap} from "@app/lambda";
import {SecurityRequirementObject} from "openapi3-ts/src/model/openapi31";

const Id = {
    id: T.String()
}
const authenticated: SecurityRequirementObject[] = [{"Cookie": []}]
export default {
    "POST /tip/registration": {
        operationId: "Register",
        security: authenticated,
        tags: ['Tip']
    },
    "GET /tip/invites": {
        operationId: "ListInvites",
        query: {
            accepted: T.Optional(T.Boolean()),
            rejected: T.Optional(T.Boolean()),
        },
        success: T.Null(),
        tags: ['Tip']
    },
    "GET /tip/invite/{id}": {
        operationId: "GetInvite",
        body: T.Null(),
        success: T.Null(),
        path: Id,
        tags: ['Tip']
    },
    "PUT /tip/invite/{id}": {
        operationId: "AcceptInvite",
        success: T.Null(),
        path: Id,
        tags: ['Tip']
    },
    "DELETE /tip/invite/{id}": {
        operationId: "RejectInvite",
        body: T.Null(),
        success: T.Null(),
        path: Id,
        tags: ['Tip']
    }
} as const satisfies RouteMap
