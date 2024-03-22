import {Lambdas} from "@aws/lambdas";
import {dataTable, allowCrud} from "@aws/dynamodb";
import Routes from "@src/tip/routes";
import authorizer from "../authorizer";

const lambda = authorizer.gateway.newLambda(Lambdas['tip.invite'])
    .inlinePolicy(allowCrud().on(dataTable).build())
    .build()

export default authorizer.newAuthorizedIntegration(lambda)
    .addRoutes(Routes)
    .done()


