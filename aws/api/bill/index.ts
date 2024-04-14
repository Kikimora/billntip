import {Lambdas} from "@aws/lambdas";
import {dataTable, allowCrud} from "@aws/dynamodb";
import Routes from "@src/bill/routes";
import authorizer from "../authorizer";

const lambda = authorizer.gateway.newLambda(Lambdas['bill.invite'])
    .inlinePolicy(allowCrud().on(dataTable).buildRoleInlinePolicy())
    .build()

export default authorizer.newAuthorizedIntegration(lambda)
    .addRoutes(Routes)
    .done()


