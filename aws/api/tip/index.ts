import {Lambdas} from "@aws/lambdas";
import {dataTable, allowCrud, usersTable, locksTable} from "@aws/dynamodb";
import Paths from "@src/billntip/tip-paths";
import authorizer from "../authorizer";
import cognito from "@aws/cognito";
import {newPolicy} from "@aws/util";

const lambda = authorizer.gateway.newLambda(Lambdas['billntip/tip.handler'])
    .args({
        environment: {
            variables: {
                USER_POOL_ID: cognito.userPool.id,
                DATA_TABLE: dataTable.name,
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


