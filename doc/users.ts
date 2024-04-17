import {OpenAPIBuilder} from "@app/lambda";
import UserPaths from "../src/users/paths";

export default function (api: OpenAPIBuilder) {
    api.paths(UserPaths)
}
