import * as schemas from "@src/billntip/schemas";
import {Type} from "@sinclair/typebox";
import {RouteMap} from "@app/lambda";
import {Transaction} from "@src/billntip/schemas";

export default {
    "POST /pay/session": {
        operationId: "POST /pay/session",
        description: "Initate new payeer session",
        success: Type.Object({
            uid: Type.String()
        }),
        responses: [401, 403],
        tags: ['Pay']
    },
    "POST /pay/card": {
        operationId: "POST /pay/card",
        description: "Create new empty payment card, endpoint returns card tokenization parameters.",
        body: Type.Intersect([
            schemas.NewEmptyCardRequest,
            Type.Object({
                payer: Type.String({maxLength: 40})
            })
        ]),
        success: schemas.CardRegistration,
        responses: [401, 403],
        tags: ['Pay']
    },
    "PUT /pay/card": {
        operationId: "PUT /pay/card",
        description: "Fill empty payment card with details.",
        body: Type.Object({
            id: Type.String({maxLength: 128}),
            payer: Type.String({maxLength: 128}),
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
    },
    "GET /pay/tx": {
        operationId: "GET /pay/tx",
        description: "Get a transaction details",
        query: {
            payer: Type.String({maxLength: 40}),
            id: Type.String({maxLength: 40})
        },
        success: schemas.Transaction,
        responses: [400, 404],
        tags: ['Pay']
    }
} satisfies RouteMap