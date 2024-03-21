import {pipeline} from '@app/lambda'
import _ from "lodash";
import {configure} from "@app/diagnostics";

export const Routes = {
    "GetInvite": "GET /bill/invite/{id}",
    "ListInvites": "GET /bill/invites",
    "CreateInvite": "POST /bill/invite",
    "DeleteInvite": "DELETE /bill/invite/{id}"
} as const

configure({triggers: {request: true}})

export const invite = pipeline()
    .requireLambdaAuth()
    .traceRequest()
    .withRoutes(Routes)
    .parseJsonBody()
    .done(async function (e) {
        switch (e.routeKey) {
            case 'GET /bill/invites': {
                return {"operation": "GetInvites"}
            }
            case 'POST /bill/invite': {
                return {"operation": "CreateInvite"}
            }
            case 'GET /bill/invite/{id}': {
                const {id} = e.pathParameters ?? _.throw("'id' required")
                return {id}
            }
            case 'DELETE /bill/invite/{id}': {
                const {id} = e.pathParameters ?? _.throw("'id' required")
                return {id}
            }
        }
    })
