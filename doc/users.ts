import {OpenAPIBuilder} from "@app/lambda";
import UserPaths from "../src/users/paths";
import * as Schemas from "../src/users/schemas";

export default function (api: OpenAPIBuilder) {
    api.paths(UserPaths).spec = {
        'POST /user/signin': {
            description: `
Successful sign-in produces a session cookie with a lifetime corresponding to an underlying refresh token. Session cookie has an inactivity period. If user is 
not active (makes no requests) withing this period then the cookie expire and is not longer valid even thou refresh token is.
            `
        },
        'POST /user/session': {
            description: `
Refresh session and produce new session cookie. Old session cookie is still valid but may result in a stale cached responses from GET /user/session endpoint. 
            `,
            responses: [{
                '200': {
                    headers: {
                        'Set-Cookie': {
                            summary: "Session Cookie",
                            description: 'Refreshed session cookie',
                            schema: Schemas.Cookie
                        }
                    }
                }
            }]
        }
    }
}
