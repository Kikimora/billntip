import _ from "lodash";
import {newApiGwIntegration, newPolicy} from "@aws/util";
import {Lambdas} from "@aws/lambdas";
import gateway from "@aws/api/gateway";
import authorizer from "@aws/api/authorizer";
import cognito from "@aws/cognito";
import apiClient from "@aws/api/cognito-api-client";
import Routes from "@src/users/routes";

const users = gateway.newLambda(Lambdas["users.handler"])
    .args({
        timeout: 10,
        environment: {
            variables: {
                OAUTH_CLIENT_ID: apiClient.id,
                USER_POOL_ID: cognito.userPool.id
            }
        }
    })
    .inlinePolicy(newPolicy('UserPoolAccess')
        .allow(
            "cognito-idp:DescribeUserPoolClient",
            ..._.map(Routes, 'operationId').map(x => `cognito-idp:${x}`)
        )
        .on(cognito.userPool)
        .build())
    .build()
const publicRoutes = _.pickBy(Routes, function (value) {
    return value.public;
})
const protectedRoutes = _.pickBy(Routes, function (value) {
    return !value.public;
})
export default newApiGwIntegration(gateway, users, authorizer.integrationArgs)
    .defaults(authorizer.apiRouteArgs)
    .addRoutes(protectedRoutes)
    .defaults({})
    .addRoutes(publicRoutes)
    .done()