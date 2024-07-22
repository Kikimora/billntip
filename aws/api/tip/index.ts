import * as pulumi from "@pulumi/pulumi"
import {Lambdas} from "@aws/lambdas";
import ddb, {allowCrud} from "@aws/dynamodb";
import Paths from "@src/billntip/tip-paths";
import HookPaths from "@src/billntip/mangopay-hooks-paths";
import authorizer from "../authorizer";
import cognito from "@aws/cognito";
import {newApiGwIntegration, newPolicy} from "@aws/util";
import {bucket} from "@aws/s3";

const gw = authorizer.gateway;
const lambda = gw.newLambda(Lambdas['billntip/tip.handler'])
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

export const api = authorizer.newAuthorizedIntegration(lambda)
    .addRoutes(Paths)
    .done()


export const hooks = newApiGwIntegration(gw, gw.newLambda(Lambdas['billntip/mangopay-hooks.handler'])
    .args({timeout: 10})
    .inlinePolicy(allowCrud().on(ddb.dataTable).buildRoleInlinePolicy('DynamoDbAccess'))
    .inlinePolicy(
        newPolicy().allow('s3:GetObject').on(pulumi.interpolate`${bucket.arn}/templates/*`).buildRoleInlinePolicy('S3Access')
    )
    .build())
    .addRoutes(HookPaths)
    .done()