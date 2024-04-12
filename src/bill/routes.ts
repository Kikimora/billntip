import {RouteMap} from "@app/lambda";
import {Type} from "@sinclair/typebox";

export default {
    "GET /bill/invites": {operationId: "ListInvites"},
    "POST /bill/invites": {operationId: "CreateInvite"},
    "GET /bill/invite/{id}": {
        operationId: "GetInvite",
        path: {
            id: Type.String()
        }
    },
    "PUT /bill/invite/{id}": {operationId: "UpdateInvite"},
    "DELETE /bill/invite/{id}": {
        operationId: "DeleteInvite",
        path: {
            id: Type.String()
        }
    }
} as const satisfies RouteMap