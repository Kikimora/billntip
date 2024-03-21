import {pipeline} from '@app/lambda'
import _ from "lodash";

export const Routes = {
    "GetInvite": "GET /tip/invite/{id}",
    "ListInvites": "GET /tip/invites",
    "AcceptInvite": "PUT /tip/invite/{id}",
    "RejectInvite": "DELETE /tip/invite/{id}"
} as const

export const handler = pipeline()
    .do(async function () {
    })
    .requireLambdaAuth()
    .traceRequest()
    .withRoutes(Routes)
    .parseJsonBody()
    .done(async function (e) {
        switch (e.routeKey) {
            case 'PUT /tip/invite/{id}': {
                const {id} = e.pathParameters ?? _.throw("'id' required")
                return {operation: "AcceptInvite", id}
            }
            case 'DELETE /tip/invite/{id}': {
                const {id} = e.pathParameters ?? _.throw("'id' required")
                return {operation: "RejectInvite", id}
            }
            case 'GET /tip/invite/{id}': {
                const {id} = e.pathParameters ?? _.throw("'id' required")
                return {operation: "GetInvite", id}
            }
            case 'GET /tip/invites': {
                return {operation: "GetInvites"}
            }
        }
    })
