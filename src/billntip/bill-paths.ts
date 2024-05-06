import {RouteMap} from "@app/lambda";
import {Type} from "@sinclair/typebox";
import {SecurityRequirementObject} from "openapi3-ts/src/model/openapi31";

export const authenticatedEndpoint: SecurityRequirementObject[] = [{"Cookie": ["admin", "business"]}]

const OrgId = {
    orgId: Type.String()
} as const;
const InviteId = {
    id: Type.String()
} as const;
export default {
    "GET /bill/{orgId}/invites": {
        operationId: "ListInvites",
        path: OrgId,
        body: Type.Object({
            startKey: Type.Optional(Type.String())
        }),
        tags: ['Bill']
    },
    "POST /bill/{orgId}/invite": {
        operationId: "CreateInvite",
        summary: "Invite user into Tips app",
        security: authenticatedEndpoint,
        path: OrgId,
        body: Type.Object({
            email: Type.String(),
            resend: Type.Optional(Type.Boolean({default: false}))
        }),
        tags: ['Bill']
    },
    "GET /bill/invite/{orgId}/{id}": {
        operationId: "GetInvite",
        security: authenticatedEndpoint,
        path: {...OrgId, ...InviteId},
        tags: ['Bill']
    },
    "PUT /bill/invite/{orgId}/{id}": {
        operationId: "UpdateInvite",
        security: authenticatedEndpoint,
        path: {...OrgId, ...InviteId},
        tags: ['Bill']
    },
    "DELETE /bill/invite/{orgId}/{id}": {
        operationId: "DeleteInvite",
        security: authenticatedEndpoint,
        path: {...OrgId, ...InviteId},
        tags: ['Bill']
    }
} as const satisfies RouteMap