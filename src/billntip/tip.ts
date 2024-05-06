import _ from "lodash";
import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {badRequestError, pipeline} from '@app/lambda'
import Paths from "./tip-paths";
import {SessionContext} from "@src/authorizer/session";
import UserRepo from "@src/users/user";
import {die} from "@app/util";
import {Type} from "@sinclair/typebox";
import {Value} from "@sinclair/typebox/value";
import {intervalToDuration} from "date-fns";
import Store from "./store";
import {errorWithContext} from "@app/diagnostics";

const UserPoolId = process.env.USER_POOL_ID ?? die("USER_POOL_ID required")
const DataTableName = process.env.DATA_TABLE ?? die("DATA_TABLE required")
const dynamo = new DynamoDB()
const cognito = new CognitoIdentityProvider()

const RecipientSchema = Type.Object({
    first_name: Type.String({minLength: 3, maxLength: 100}),
    last_name: Type.String({minLength: 3, maxLength: 100}),
    phone: Type.String({minLength: 3, pattern: "\\+\\d+", maxLength: 100}),
    birthdate: Type.Number({minimum: 18, maximum: 200}),
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
        const store = new Store({table: DataTableName})
        switch (req.routeKey) {
            case 'POST /tip/registration': {
                const username = req.user.profile['cognito:username']
                const repo = new UserRepo({
                    tracer: req.tracer,
                    tag: req.requestContext.requestId,
                    db: dynamo
                })
                const user = await repo.fetch(username)
                const attributes = _(user.attributes).keyBy('name').mapValues('value').value()
                const {
                    first_name,
                    last_name,
                    phone: phone,
                    birthdate: birthdateStr,
                    address: addressJSON,
                    nationality: nationality,
                    tos: tosJSON
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
                    first_name, last_name, phone, birthdate: age, address, nationality, tos
                };
                Value.Decode(RecipientSchema, userDetails)

                await cognito.adminAddUserToGroup({
                    GroupName: 'recipient',
                    Username: user.username,
                    UserPoolId
                })

                const pendingInvites = await store.memberships(username, {
                    accepted: false,
                    rejected: false
                })

                return {
                    pendingInvites: _.map(pendingInvites, x => ({
                        role: x.role,
                        invited_at: x.invited_at,
                        invited_by: x.invited_by,
                        org: x.org
                    }))
                }
            }
            case 'PUT /tip/invite/{id}': {
                const {path: {id}} = req.parse()
                const username = req.user.profile['cognito:username']
                const store = new Store({table: DataTableName})
                try {
                    return await store.acceptInvite(username, id)
                } catch (e: any) {
                    switch (e.name) {
                        case 'ConditionalCheckFailedException': {
                            throw badRequestError('Invite already accepted or does not exists')
                                .withContext('acceptInvite')
                        }
                        default:
                            throw errorWithContext(e, 'acceptInvite')
                    }
                }
            }
            case 'DELETE /tip/invite/{id}': {
                const {path: {id}} = req.parse()
                const username = req.user.profile['cognito:username']
                try {
                    return await store.rejectInvite(username, id)
                } catch (e: any) {
                    switch (e.name) {
                        case 'ConditionalCheckFailedException': {
                            throw badRequestError('Invite already does not exists')
                                .withContext('rejectInvite')
                        }
                        default:
                            throw errorWithContext(e, 'rejectInvite')
                    }
                }
            }
            case 'GET /tip/invite/{id}': {
                const {path: {id}} = req.parse()
                const username = req.user.profile['cognito:username']
                return await store.fetchMember(username, id)
            }
            case 'GET /tip/invites': {
                const {query} = req.parse()
                const username = req.user.profile['cognito:username']
                return await store.memberships(username, query)
            }
        }
    })
