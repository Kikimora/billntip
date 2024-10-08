import {Lambdas} from "@aws/lambdas";
import Paths from "@src/billntip/pay-paths";
import gw from "../gateway";
import {newApiGwIntegration} from "@aws/util";
import ddb, {allowCrud} from "@aws/dynamodb";
import * as pulumi from "@pulumi/pulumi";

const lambda = gw.newLambda(Lambdas['billntip/pay.handler'])
    .args({
        timeout: 10
    })
    .inlinePolicy(allowCrud().on(ddb.usersTable, ddb.locksTable, ddb.dataTable, pulumi.interpolate`${ddb.dataTable.arn}/index/inverse`).buildRoleInlinePolicy("DynamoDbAccess"))
    .build()

export default newApiGwIntegration(gw, lambda)
    .addRoutes(Paths)
    .done()