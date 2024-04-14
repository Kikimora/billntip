import {Lambdas} from "@aws/lambdas";
import {dataTable, allowCrud} from "@aws/dynamodb";
import authorizer from "../authorizer";

const apiServiceLambda = authorizer.gateway.newLambda(Lambdas['api.handler'])
    .args({
        timeout: 5,
        memorySize: 512
    })
    .inlinePolicy(allowCrud().on(dataTable).buildRoleInlinePolicy())
    .build()

export default authorizer.newAuthorizedIntegration(apiServiceLambda)
    .addRoute({routeKey: "$default"})
    .done()
