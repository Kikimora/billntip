import {ErrorSchema, openapi} from "@app/lambda";
import upath from "upath";
import users from "@app/doc/users";
import images from "@app/doc/images";

export default function () {
    const api = openapi()
        .spec(upath.joinSafe(__dirname, "index.yaml"))
        .consumes("application/json")
        .produces("application/json")
        .response(400, {schema: ErrorSchema})
        .response(401, {schema: ErrorSchema})
        .response(403, {schema: ErrorSchema})
    users(api)
    images(api)
    return api.build()
}