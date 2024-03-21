import {newApiGwIntegration, newLambda} from "@aws/util";
import * as authorizer from "../authorizer";
import * as gateway from "../gateway";
import {allowDynamoDb, Lambdas} from "@aws/lambdas";
import {dataTable} from "@aws/dynamodb";
import {Routes} from "@src/bill";

const lambda = newLambda(Lambdas['bill.invite'])
    .inlinePolicy(allowDynamoDb.on(dataTable).build())
    .grantInvoke(gateway)
    .build()

export default newApiGwIntegration(gateway.id, lambda)
    .defaults({
        authorizationType: "CUSTOM",
        authorizerId: authorizer.id
    })
    .addRoutes(Routes)
    .done()


