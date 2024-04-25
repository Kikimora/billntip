import {OpenAPIBuilder} from "@app/lambda";
import UserPaths from "../src/users/paths";
import * as Schemas from "../src/users/schemas";

export default function (api: OpenAPIBuilder) {
    api.paths(UserPaths).spec = {
        'POST /user/session': {
            responses: [{
                '200': {
                    headers: {
                        'Set-Cookie': {
                            summary:"Session Cookie",
                            description: 'Refreshed session cookie',
                            schema: Schemas.Cookie
                        }
                    }
                }
            }]
        }
    }
}
