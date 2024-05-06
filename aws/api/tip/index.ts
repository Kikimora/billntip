import {Lambdas} from "@aws/lambdas";
import {dataTable, allowCrud, locksTable, usersTable} from "@aws/dynamodb";
import Paths from "@src/tip/paths";
import authorizer from "../authorizer";
import {newPolicy} from "@aws/util";
import _ from "lodash";
import cognito from "@aws/cognito";

const lambda = authorizer.gateway.newLambda(Lambdas['tip.handler'])
    .args({
        environment: {
            variables: {
                USER_POOL_ID: cognito.userPool.id,
                LOCKS_TABLE: locksTable.name,
                USERS_TABLE: usersTable.name
            }
        },
        timeout: 10
    })
    .inlinePolicy(allowCrud().on(usersTable, dataTable, locksTable).buildRoleInlinePolicy('DynamoDbAccess'))
    .inlinePolicy(
        newPolicy()
            .allow(
                "cognito-idp:AdminAddUserToGroup"
            )
            .on(cognito.userPool)
            .buildRoleInlinePolicy('UserPoolAccess')
    )
    .build()

export default authorizer.newAuthorizedIntegration(lambda)
    .addRoutes(Paths)
    .done()


