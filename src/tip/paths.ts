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
        security: authenticated
    },
    "GET /tip/invites": {
        operationId: "ListInvites",
        body: T.Null(),
        success: T.Null(),
        path: Id
    },
    "GET /tip/invite/{id}": {
        operationId: "GetInvite",
        body: T.Null(),
        success: T.Null(),
        path: Id
    },
    "PUT /tip/invite/{id}": {
        operationId: "AcceptInvite",
        body: T.Null(),
        success: T.Null(),
        path: Id
    },
    "DELETE /tip/invite/{id}": {
        operationId: "RejectInvite",
        body: T.Null(),
        success: T.Null(),
        path: Id
    }
} as const satisfies RouteMap
