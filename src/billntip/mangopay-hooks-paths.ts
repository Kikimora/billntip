import {Static, Type} from "@sinclair/typebox";
import {RouteMap} from "@app/lambda";

const MangoPayHookQuery = {
    EventType: Type.String(),
    //This is a typo but this is actual parameter name.
    RessourceId: Type.String(),
    Date: Type.String()
}
const TMangoPayHookQuery = Type.Object(MangoPayHookQuery)
export type MangoPayHookQuery = Static<typeof TMangoPayHookQuery>

export default {
    'GET /tip/mangopay/callback': {
        query: MangoPayHookQuery
    }
} as const satisfies RouteMap
