import {RouteMap} from "@app/lambda";
import {Type} from "@sinclair/typebox";
import {SecurityRequirementObject} from "openapi3-ts/src/model/openapi31";
import {MemberSchema} from "@src/billntip/schemas";

export const authenticatedEndpoint: SecurityRequirementObject[] = [{"Cookie": ["admin", "business"]}]

const OrgId = {
    orgId: Type.String()
} as const;
const InviteId = {
    id: Type.String()
} as const;
export default {
    "GET /bill/{orgId}/members": {
        operationId: "GET /bill/{orgId}/members",
        security: authenticatedEndpoint,
        path: OrgId,
        query: {
            startKey: Type.Optional(Type.String())
        },
        success: Type.Object({
            lastKey: Type.Optional(Type.String()),
            members: Type.Array(MemberSchema)
        }),
        responses: [401, 403, 404],
        tags: ['Bill']
    },
    "POST /bill/{orgId}/members": {
        operationId: "POST /bill/{orgId}/members",
        summary: "Invite new users",
        security: authenticatedEndpoint,
        path: OrgId,
        body: Type.Object({
            email: Type.String()
        }),
        success: MemberSchema,
        responses: [401, 403, 404],
        tags: ['Bill']
    },
    "GET /bill/{orgId}/members/{id}": {
        operationId: "GET /bill/{orgId}/members/{id}",
        security: authenticatedEndpoint,
        path: {...OrgId, ...InviteId},
        success: MemberSchema,
        responses: [401, 403, 404],
        tags: ['Bill']
    },
    "PUT /bill/{orgId}/members/{id}": {
        operationId: "PUT /bill/{orgId}/members/{id}",
        security: authenticatedEndpoint,
        path: {...OrgId, ...InviteId},
        success: MemberSchema,
        responses: [401, 403, 404],
        tags: ['Bill']
    },
    "DELETE /bill/{orgId}/members/{id}": {
        operationId: "DELETE /bill/{orgId}/members/{id}",
        security: authenticatedEndpoint,
        path: {...OrgId, ...InviteId},
        success: MemberSchema,
        responses: [401, 403, 404],
        tags: ['Bill']
    }
} as const satisfies RouteMap