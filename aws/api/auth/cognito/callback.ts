import {Lambdas} from "@aws/lambdas";
import authorizer from "../../authorizer";

const codeLambda = authorizer.newAuthLambda(Lambdas['authorizer.code']).build()
export default authorizer.newAuthorizedIntegration(codeLambda)
    //Erase defaults to drop authorizer on auth callback route
    .defaults({})
    .addRoute({routeKey: `GET ${authorizer.gateway.authCallbackPath}`})
    .done()