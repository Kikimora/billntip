import {RouteMap} from "@app/lambda";
import {Type} from "@sinclair/typebox";
import {SecurityRequirementObject} from "openapi3-ts/src/model/openapi31";
import * as schemas from "./schemas";
import {MemberRole} from "./schemas";
import {Upload} from "@src/object-store";

export const authenticatedEndpoint: SecurityRequirementObject[] = [{"Cookie": ["admin", "business"]}]
export const adminEndpoint: SecurityRequirementObject[] = [{"Cookie": ["admin"]}]

const OrgId = {
    orgId: Type.String({
        description: "Organisation id",
        minLength: 1
    })
} as const;
const UserId = {
    id: Type.String({
        format: "uuid",
        description: "User id"
    })
} as const;
const LocationId = {
    id: Type.String({
        format: "uuid",
        description: "Location id"
    })
} as const;
export default {

    "GET /admin/organizations": {
        operationId: "GET /admin/organizations",
        security: adminEndpoint,
        query: {
            from: Type.Optional(Type.String())
        },
        success: Type.Object({
            next: Type.Optional(Type.String()),
            organizations: Type.Array(schemas.PublicOrgInfo)
        }),
        responses: [401, 403],
        tags: ['Admin']
    },

    "GET /bill/{orgId}/members": {
        operationId: "GET /bill/{orgId}/members",
        security: authenticatedEndpoint,
        path: OrgId,
        query: {
            from: Type.Optional(Type.String()),
            location: Type.Optional(Type.String()),
        },
        success: Type.Object({
            next: Type.Optional(Type.String()),
            members: Type.Array(schemas.MemberSchema)
        }),
        responses: [401, 403, 404],
        tags: ['Bill']
    },
    "POST /bill/{orgId}/members": {
        operationId: "POST /bill/{orgId}/members",
        security: authenticatedEndpoint,
        path: OrgId,
        body: Type.Object({
            email: Type.String()
        }),
        success: schemas.MemberSchema,
        responses: [401, 403, 404],
        tags: ['Bill']
    },
    "GET /bill/{orgId}/members/{id}": {
        operationId: "GET /bill/{orgId}/members/{id}",
        security: authenticatedEndpoint,
        path: {...OrgId, ...UserId},
        success: Type.Object({
            member: schemas.MemberSchema,
            locations: Type.Array(schemas.Location)
        }),
        responses: [401, 403, 404],
        tags: ['Bill']
    },
    "PUT /bill/{orgId}/members/{id}": {
        operationId: "PUT /bill/{orgId}/members/{id}",
        security: authenticatedEndpoint,
        path: {...OrgId, ...UserId},
        body: Type.Object({
            role: MemberRole
        }),
        success: schemas.MemberSchema,
        responses: [401, 403, 404],
        tags: ['Bill']
    },
    "DELETE /bill/{orgId}/members/{id}": {
        operationId: "DELETE /bill/{orgId}/members/{id}",
        security: authenticatedEndpoint,
        path: {...OrgId, ...UserId},
        success: schemas.MemberSchema,
        responses: [401, 403, 404],
        tags: ['Bill']
    },
    "GET /bill/{orgId}/locations": {
        operationId: "GET /bill/{orgId}/locations",
        security: authenticatedEndpoint,
        path: OrgId,
        query: schemas.LocationsQuery,
        success: Type.Object({
            lastKey: Type.Optional(Type.String()),
            data: Type.Array(schemas.Location)
        }),
        responses: [400, 401, 403],
        tags: ['Bill']
    },
    "GET /bill/{orgId}/locations/{id}": {
        operationId: "GET /bill/{orgId}/locations/{id}",
        security: authenticatedEndpoint,
        path: {...OrgId, ...LocationId},
        success: Type.Object({
            location: schemas.Location,
            members: Type.Array(schemas.MemberSchema)
        }),
        responses: [401, 403, 404],
        tags: ['Bill']
    },
    "POST /bill/{orgId}/locations": {
        operationId: "POST /bill/{orgId}/locations",
        security: authenticatedEndpoint,
        path: OrgId,
        body: schemas.LocationRequest,
        success: schemas.Location,
        responses: [400, 401, 403],
        tags: ['Bill']
    },
    "POST /bill/{orgId}/locations/image": {
        operationId: "POST /bill/{orgId}/locations/image",
        security: authenticatedEndpoint,
        path: {...OrgId, ...LocationId},
        success: Upload,
        responses: [401, 403],
        tags: ['Bill']
    },
    "PUT /bill/{orgId}/locations/{id}": {
        operationId: "PUT /bill/{orgId}/locations/{id}",
        security: authenticatedEndpoint,
        path: {...OrgId, ...LocationId},
        body: schemas.LocationRequest,
        success: schemas.Location,
        responses: [400, 401, 403, 404],
        tags: ['Bill']
    },
    "PATCH /bill/{orgId}/locations/{id}": {
        operationId: "PATCH /bill/{orgId}/locations/{id}",
        security: authenticatedEndpoint,
        path: {...OrgId, ...LocationId},
        body: Type.Object({
            addUser: Type.Optional(Type.String({
                minLength: 1,
                description: "Id of a user to assign to the location."
            })),
            removeUser: Type.Optional(Type.String({
                minLength: 1,
                description: "Id of a user to remove from to the location."
            })),
        }),
        success: Type.Object({
            org_id: Type.String(),
            id: Type.String(),
            user_id: Type.String(),
        }),
        responses: [400, 401, 403, 404],
        tags: ['Bill']
    },
    "DELETE /bill/{orgId}/locations/{id}": {
        operationId: "DELETE /bill/{orgId}/locations/{id}",
        security: authenticatedEndpoint,
        path: {...OrgId, ...LocationId},
        success: schemas.LocationRequest,
        responses: [401, 403, 404],
        tags: ['Bill']
    },

} as const satisfies RouteMap