import * as schemas from "@src/billntip/schemas";
import {Type} from "@sinclair/typebox";
import {RouteMap} from "@app/lambda";

export default {
    "POST /pay/session": {
        operationId: "POST /pay/session",
        body: schemas.NewEmptyCardRequest,
        success: Type.Object({
            uid: Type.String()
        }),
        responses: [401, 403],
        tags: ['Pay']
    },
    "POST /pay/card": {
        operationId: "POST /pay/card",
        body: Type.Intersect([
            Type.Omit(schemas.Card, ['id']),
            Type.Object({
                payer: Type.String({maxLength: 40})
            })
        ]),
        success: schemas.EmptyCard,
        responses: [401, 403],
        tags: ['Pay']
    },
    "PUT /pay/card": {
        operationId: "PUT /pay/card",
        body: Type.Object({
            id: Type.String({maxLength: 40}),
            payer: Type.String({maxLength: 40}),
            cardholder_name: Type.String({maxLength: 120}),
            token: Type.String(),
        }),
        success: schemas.Card,
        responses: [400, 401, 403],
        tags: ['Pay']
    },
    "GET /pay/tip": {
        operationId: "GET /pay/tip",
        description: "Tip settings dictating what options are valid for a subsequent POST /pay/tip call.",
        query: {
            org: Type.String(),
            location: Type.String(),
            recipient: Type.Optional(Type.String())
        },
        success: schemas.TipSettings,
        responses: [400, 404],
        tags: ['Pay']
    },
    "POST /pay/tip": {
        operationId: "POST /pay/tip",
        description: "Pay tip to the selected recipient",
        body: schemas.TipRequest,
        success: schemas.TipResponse,
        responses: [400],
        tags: ['Pay']
    }
} satisfies RouteMap