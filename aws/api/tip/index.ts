import * as pulumi from "@pulumi/pulumi"
import {Lambdas} from "@aws/lambdas";
import ddb, {allowCrud} from "@aws/dynamodb";
import Paths from "@src/billntip/tip-paths";
import authorizer from "../authorizer";
import cognito from "@aws/cognito";
import {newPolicy} from "@aws/util";
import {bucket} from "@aws/s3";

const lambda = authorizer.gateway.newLambda(Lambdas['billntip/tip.handler'])
    .args({
        environment: {
            variables: {
                USER_POOL_ID: cognito.userPool.id,
                DATA_TABLE: ddb.dataTable.name,
                LOCKS_TABLE: ddb.locksTable.name,
                USERS_TABLE: ddb.usersTable.name,
                BUCKET: bucket.id
            }
        },
        timeout: 10
    })
    .inlinePolicy(allowCrud().on(ddb.usersTable, ddb.dataTable, ddb.locksTable).buildRoleInlinePolicy('DynamoDbAccess'))
    .inlinePolicy(
        newPolicy()
            .allow(
                "cognito-idp:AdminAddUserToGroup"
            )
            .on(cognito.userPool)
            .buildRoleInlinePolicy('UserPoolAccess')
    )
    .inlinePolicy(
        newPolicy().allow('s3:GetObject').on(pulumi.interpolate`${bucket.arn}/templates/*`).buildRoleInlinePolicy('S3Access')
    )
    .build()

export default authorizer.newAuthorizedIntegration(lambda)
    .addRoutes(Paths)
    .done()


