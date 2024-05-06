import {OpenAPIBuilder} from "@app/lambda";
import Bill from "@src/billntip/bill-paths";
import Tip from "@src/billntip/tip-paths";

export default function (api: OpenAPIBuilder) {
    api.paths({...Bill, ...Tip})
}
