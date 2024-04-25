import _ from "lodash";
import {newPolicy} from "@aws/util";
import {Lambdas} from "@aws/lambdas";
import authorizer from "@aws/api/authorizer";
import cognito from "@aws/cognito";
import Paths from "@src/users/paths";
import {allowCrud, locksTable, sessionsTable, usersTable} from "@aws/dynamodb";

const users = authorizer.newAuthLambda(Lambdas["users.handler"])
    .args({
        timeout: 10,
        memorySize: 256,
        environment: {
            variables: {
                USERS_TABLE: usersTable.name
            }
        }
    })
    .inlinePolicy(
        newPolicy('UserPoolAccess')
            .allow(
                ..._.map(Paths, 'operationId').map(x => `cognito-idp:${x}`)
            )
            .on(cognito.userPool)
            .buildRoleInlinePolicy(),
        allowCrud("UsersTableAccess").on(usersTable).buildRoleInlinePolicy())
    .build()
const publicRoutes = _.pickBy(Paths, function (value) {
    return value.security?.length === 0;
})
const protectedRoutes = _.pickBy(Paths, function (value) {
    return value.security?.length > 0;
})
export default authorizer.newAuthorizedIntegration(users)
    .addRoutes(protectedRoutes)
    .defaults({})
    .addRoutes(publicRoutes)
    .done()