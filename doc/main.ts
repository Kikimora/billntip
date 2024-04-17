import {Type} from "@sinclair/typebox";
import {openapi} from "@app/lambda";
import upath from "upath";
import users from "@app/doc/users";
import images from "@app/doc/images";

export default function () {
    const Error = Type.Object({
        error: Type.String(),
        message: Type.String()
    });
    const api = openapi()
        .spec(upath.joinSafe(__dirname, "index.yaml"))
        .consumes("application/json")
        .produces("application/json")
        .response(400, {schema: Error})
        .response(401, {schema: Error})
    users(api)
    images(api)
    return api.build()
}