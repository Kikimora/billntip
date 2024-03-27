import {Type as T} from '@sinclair/typebox';
import {RouteMap} from "@app/lambda";

const Id = T.Object({
    id: T.String()
})

export default {
    "GET /tip/invites": {
        operationId: "ListInvites",
        body: T.Null(),
        res: T.Null(),
        query: Id
    },
    "GET /tip/invite/{id}": {
        operationId: "GetInvite",
        body: T.Null(),
        res: T.Null(),
        query: Id
    },
    "PUT /tip/invite/{id}": {
        operationId: "AcceptInvite",
        body: T.Null(),
        res: T.Null(),
        query: Id
    },
    "DELETE /tip/invite/{id}": {
        operationId: "RejectInvite",
        body: T.Null(),
        res: T.Null(),
        query: Id
    }
} as const satisfies RouteMap
