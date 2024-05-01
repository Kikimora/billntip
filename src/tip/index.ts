import _ from "lodash";
import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {pipeline} from '@app/lambda'
import Paths from "./paths";
import {SessionContext} from "@src/authorizer/session";
import UserRepo from "@src/users/user";
import {die} from "@app/util";
import {Type} from "@sinclair/typebox";
import {Value} from "@sinclair/typebox/value";
import {intervalToDuration} from "date-fns";

const UserPoolId = process.env.USER_POOL_ID ?? die("USER_POOL_ID required")
const dynamo = new DynamoDB()
const cognito = new CognitoIdentityProvider()

const RecipientSchema = Type.Object({
    firstName: Type.String({minLength: 3}),
    lastName: Type.String({minLength: 3}),
    phone: Type.String({minLength: 3, pattern: "\\+\\d+"}),
    age: Type.Number({minimum: 18}),
    address: Type.Object({
        country: Type.String({minLength: 2, maxLength: 3})
    }),
    nationality: Type.String({minLength: 2, maxLength: 3}),
    tos: Type.Object({
        general: Type.Literal(true),
        privacy: Type.Literal(true),
    })
})

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .requireLambdaAuth<SessionContext>()
    .withRoutes(Paths)
    .parseJsonBody()
    .done(async function (req) {
        switch (req.routeKey) {
            case 'POST /tip/registration': {
                const username = req.user.profile['cognito:username']
                const repo = new UserRepo(req, dynamo)
                const user = await repo.fetch(username)
                const attributes = _(user.attributes).keyBy('name').mapValues('value').value()
                const {
                    given_name: firstName,
                    family_name: lastName,
                    phone: phone,
                    birthdate: birthdateStr,
                    address: addressJSON,
                    'custom:nationality': nationality,
                    'custom:tos': tosJSON
                } = attributes
                const address = JSON.parse(addressJSON)
                const tos = JSON.parse(tosJSON)
                const birthdate = Date.parse(birthdateStr)
                const interval = intervalToDuration({
                    start: birthdate,
                    end: new Date(),
                })
                const age = (interval.years ?? 0) + 1

                const userDetails = {
                    firstName, lastName, phone, age, address, nationality, tos
                };
                Value.Decode(RecipientSchema, userDetails)

                await cognito.adminAddUserToGroup({
                    GroupName: 'recipient',
                    Username: user.username,
                    UserPoolId
                })
                return {}
            }
            case 'PUT /tip/invite/{id}': {
                const {id} = req.pathParameters ?? _.throw("'id' required")
                return {operation: "AcceptInvite", id}
            }
            case 'DELETE /tip/invite/{id}': {
                const {id} = req.pathParameters ?? _.throw("'id' required")
                return {operation: "RejectInvite", id}
            }
            case 'GET /tip/invite/{id}': {
                const {id} = req.pathParameters ?? _.throw("'id' required")
                return {operation: "GetInvite", id}
            }
            case 'GET /tip/invites': {
                return {operation: "GetInvites"}
            }
        }
    })
