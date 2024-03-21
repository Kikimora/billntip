import { jwtDecode } from "jwt-decode";
import {pipeline} from "@app/lambda";
import {SessionContext} from "@src/authorizer/session";

export const handler = pipeline()
    .traceRequest()
    .requireLambdaAuth<SessionContext>()
    .done(function (req) {
        return Promise.resolve({
            statusCode:200,
            body: JSON.stringify({
                "access_token": jwtDecode(req.requestContext.authorizer.lambda.access_token),
                "id_token": jwtDecode(req.requestContext.authorizer.lambda.id_token),
            }, null, 2)
        })
    })
