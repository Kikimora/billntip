import _ from "lodash";
import {newPolicy} from "@aws/util";
import {Lambdas} from "@aws/lambdas";
import authorizer from "@aws/api/authorizer";
import cognito from "@aws/cognito";
import Paths from "@src/users/paths";
import ddb, {allowCrud} from "@aws/dynamodb";
import {bucket} from "@aws/s3";

const users = authorizer.newAuthLambda(Lambdas["users.handler"])
    .args({
        timeout: 10,
        memorySize: 256,
        environment: {
            variables: {
                USERS_TABLE: ddb.usersTable.name,
                BUCKET: bucket.id
            }
        }
    })
    .inlinePolicy(
        newPolicy()
            .allow(
                ..._.map(Paths, 'operationId').map(x => `cognito-idp:${x}`)
                    .concat([
                        "cognito-idp:AdminGetUser",
                        "cognito-idp:DescribeUserPool",
                    ])
            )
            .on(cognito.userPool)
            .buildRoleInlinePolicy('UserPoolAccess'),
        allowCrud().on(ddb.usersTable).buildRoleInlinePolicy("UsersTableAccess"))
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