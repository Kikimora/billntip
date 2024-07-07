import {Lambdas} from "@aws/lambdas";
import ddb, {allowCrud} from "@aws/dynamodb";
import Routes from "@src/billntip/bill-paths";
import authorizer from "../authorizer";
import cognito from "@aws/cognito";
import {newPolicy} from "@aws/util";
import {bucket} from "@aws/s3";
import * as pulumi from "@pulumi/pulumi";

const lambda = authorizer.gateway.newLambda(Lambdas['billntip/bill.handler'])
    .args({
        environment: {
            variables: {
                USER_POOL_ID: cognito.userPool.id,
                LOCKS_TABLE: ddb.locksTable.name,
                USERS_TABLE: ddb.usersTable.name,
                DATA_TABLE: ddb.dataTable.name,
                BUCKET: bucket.id
            }
        },
        timeout: 10
    })
    .inlinePolicy(allowCrud().on(ddb.usersTable, ddb.locksTable, ddb.dataTable).buildRoleInlinePolicy("DynamoDbAccess"))
    .inlinePolicy(
        newPolicy()
            .allow(
                "cognito-idp:AdminCreateUser",
                "cognito-idp:ListUsers",
            )
            .on(cognito.userPool)
            .buildRoleInlinePolicy('UserPoolAccess')
    )
    .inlinePolicy(
        newPolicy().allow('s3:GetObject').on(pulumi.interpolate`${bucket.arn}/templates/*`).buildRoleInlinePolicy('S3Access')
    )
    .inlinePolicy(
        newPolicy().allow('ses:SendEmail').on('*').buildRoleInlinePolicy('SESAccess')
    )
    .build()

export default authorizer.newAuthorizedIntegration(lambda)
    .addRoutes(Routes)
    .done()


