import _ from "lodash";
import {newPolicy} from "@aws/util";
import {Lambdas} from "@aws/lambdas";
import authorizer from "@aws/api/authorizer";
import cognito from "@aws/cognito";
import Routes from "@src/users/routes";

const users = authorizer.newAuthLambda(Lambdas["users.handler"])
    .args({timeout: 10})
    .inlinePolicy(newPolicy('UserPoolAccess')
        .allow(
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
export default authorizer.newAuthorizedIntegration(users)
    .addRoutes(protectedRoutes)
    .defaults({})
    .addRoutes(publicRoutes)
    .done()