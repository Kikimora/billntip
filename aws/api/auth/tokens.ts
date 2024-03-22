import {Lambdas} from "@aws/lambdas";
import authorizer from "../authorizer";

const tokensLambda = authorizer.newAuthLambda(Lambdas['authorizer.tokens'])
    .args({
        timeout: 5
    })
    .build()

export default authorizer.newAuthorizedIntegration(tokensLambda)
    .addRoute({routeKey: "GET /auth/tokens"})
    .done()
