import {Lambdas} from "@aws/lambdas";
import {dataTable, allowCrud, locksTable, usersTable} from "@aws/dynamodb";
import Routes from "@src/bill/routes";
import authorizer from "../authorizer";
import cognito from "@aws/cognito";
import {newPolicy} from "@aws/util";

const lambda = authorizer.gateway.newLambda(Lambdas['bill.handler'])
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
    .inlinePolicy(allowCrud().on(usersTable, locksTable).buildRoleInlinePolicy())
    .inlinePolicy(
        newPolicy('UserPoolAccess')
            .allow(
                "cognito-idp:AdminCreateUser"
            )
            .on(cognito.userPool)
            .buildRoleInlinePolicy()
    )
    .build()

export default authorizer.newAuthorizedIntegration(lambda)
    .addRoutes(Routes)
    .done()


