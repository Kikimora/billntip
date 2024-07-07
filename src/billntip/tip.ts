import _ from "lodash";
import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {Static, Type} from "@sinclair/typebox";
import {moduleConfig, pipeline} from '@app/lambda'
import {SessionContextSchema} from "@src/authorizer/types";
import UserRepo from "@src/users/user";
import Paths from "./tip-paths";
import {toMembership} from "./util";
import {MemberRepo} from "./member";
import diagnostics from "@app/diagnostics";

const dynamo = new DynamoDB()
const cognito = new CognitoIdentityProvider()

const config = moduleConfig()
    .parameters({
        dynamodb: Type.Object({
            locks: Type.String(),
            users: Type.String(),
            data: Type.String()
        }),
        oidc: Type.Object({
            userPoolId: Type.String(),
        }),
        'tip-diagnostics': Type.Object({}, {relaxed: true, default: {triggers: {request: true}}})
    })
    .build()

export function __init() {
    return config.parameters.then(({dynamodb, oidc, 'tip-diagnostics': diagnostiocsConfig}) => {
        diagnostics(diagnostiocsConfig)

        const usersRepo = new UserRepo({
            db: dynamo,
            table: dynamodb.users,
            locks: dynamodb.locks
        })
        const membersRepo = new MemberRepo({table: dynamodb.data})
        return {usersRepo, membersRepo, userPoolId: oidc.userPoolId}
    })
}

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .requireLambdaAuth(SessionContextSchema)
    .withRoutes(Paths)
    .parseJsonBody()
    .done(async function (req) {
        const {membersRepo, usersRepo, userPoolId} = await __init()
        switch (req.routeKey) {
            case 'POST /tip/registration': {
                const username = req.principal.profile['cognito:username']
                const [user, member] = await Promise.all([
                    usersRepo.fetch(username),
                    membersRepo.fetchOrCreate(username)
                ])
                await member.refresh(user.attributes)
                const [_1, _2, invites] = await Promise.all([
                    member.save(),
                    cognito.adminAddUserToGroup({
                        GroupName: 'recipient',
                        Username: user.username,
                        UserPoolId: userPoolId
                    }),
                    member.memberships({
                        rejected: false
                    })
                ])
                return {
                    invites: _.map(invites, toMembership)
                } satisfies Static<typeof req.route.success>
            }
            case 'PUT /tip/invites/{id}': {
                const {path: {id}} = req.parse()
                const username = req.principal.profile['cognito:username']
                const member = membersRepo.newMember(username)
                const membership = await member.acceptInvite(id)
                return toMembership(membership) satisfies Static<typeof req.route.success>
            }
            case 'DELETE /tip/invites/{id}': {
                const {path: {id}} = req.parse()
                const username = req.principal.profile['cognito:username']
                const member = membersRepo.newMember(username)
                const membership = await member.rejectInvite(id)
                if (membership === undefined) return undefined
                return toMembership(membership) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/invites/{id}': {
                const {path: {id}} = req.parse()
                const username = req.principal.profile['cognito:username']
                const member = membersRepo.newMember(username)
                const membership = await member.fetchMembership(id)
                return toMembership(membership) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/invites': {
                const {query} = req.parse()
                const username = req.principal.profile['cognito:username']
                const member = membersRepo.newMember(username)
                const memberships = await member.memberships(query)
                return _.map(memberships, toMembership) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/me': {
                const username = req.principal.profile['cognito:username']
                const member = await membersRepo.fetch(username)
                const [memberUser, status, wallet] = await Promise.all([
                    member.fetchUser(),
                    member.fetchRegulatoryStatus(),
                    member.fetchWallet()
                ])
                return {
                    kycLevel: memberUser.kycLevel,
                    category: memberUser.category,
                    status,
                    wallet
                } satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/transactions': {
                const {query} = req.parse()
                const username = req.principal.profile['cognito:username']
                const member = await membersRepo.fetch(username)
                const [transactions, wallet] = await Promise.all([
                    member.transactions(query),
                    member.fetchWallet(),
                ])
                // const senderIds = _(transactions).flatMap(x => [x.from, x.to]).uniq().compact().value()
                // const users = await usersRepo.batchFetch(senderIds)
                return {
                    transactions,
                    wallet
                } satisfies Static<typeof req.route.success>
            }
            case 'POST /tip/verification': {
                const {body} = req.parse()
                const username = req.principal.profile['cognito:username']
                const member = await membersRepo.fetch(username)
                return await member.startVerification(body) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/verification': {
                const username = req.principal.profile['cognito:username']
                const member = await membersRepo.fetch(username)
                return await member.fetchVerificationStatus() satisfies Static<typeof req.route.success>
            }
        }
    })
