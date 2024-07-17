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
        const username = req.principal.id_token_json['cognito:username']
        switch (req.routeKey) {
            case 'POST /tip/registration': {
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
                const member = membersRepo.newMember(username)
                const membership = await member.acceptInvite(id)
                return toMembership(membership) satisfies Static<typeof req.route.success>
            }
            case 'DELETE /tip/invites/{id}': {
                const {path: {id}} = req.parse()
                const member = membersRepo.newMember(username)
                const membership = await member.rejectInvite(id)
                if (membership === undefined) return undefined
                return toMembership(membership) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/invites/{id}': {
                const {path: {id}} = req.parse()
                const member = membersRepo.newMember(username)
                const membership = await member.fetchMembership(id)
                return toMembership(membership) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/invites': {
                const {query} = req.parse()
                const member = membersRepo.newMember(username)
                const memberships = await member.memberships(query)
                return _.map(memberships, toMembership) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/me': {
                const member = await membersRepo.fetch(username)
                const [memberUser, status, wallet] = await Promise.all([
                    member.fetchUser(),
                    member.fetchRegulatoryStatus(),
                    member.fetchWallet()
                ])
                return {
                    kyc_level: memberUser.kycLevel,
                    proof_of_identity: memberUser.proofOfIdentity !== undefined,
                    proof_of_address: memberUser.proofOfAddress !== undefined,
                    category: memberUser.category,
                    regulatory_status: status,
                    wallet: wallet.balance
                } satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/transactions': {
                const {query} = req.parse()
                const username = req.principal.id_token_json['cognito:username']
                const member = await membersRepo.fetch(username)
                const [transactions, wallet] = await Promise.all([
                    member.transactions(query),
                    member.fetchWallet(),
                ])
                return {
                    transactions,
                    wallet: wallet.balance
                } satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/transactions/{id}': {
                const {path:{id}} = req.parse()
                const username = req.principal.id_token_json['cognito:username']
                const member = await membersRepo.fetch(username)
                const [transaction, wallet] = await Promise.all([
                    member.fetchTransaction(id),
                    member.fetchWallet(),
                ])
                return {
                    transaction,
                    wallet: wallet.balance
                } satisfies Static<typeof req.route.success>
            }
            case 'POST /tip/transactions': {
                const {body} = req.parse()
                const username = req.principal.id_token_json['cognito:username']
                const member = await membersRepo.fetch(username)
                const transaction = await member.createTransaction(body)
                const wallet = await member.fetchWallet()
                return {
                    transaction,
                    wallet: wallet.balance
                } satisfies Static<typeof req.route.success>
            }
            case 'POST /tip/verification': {
                const {body} = req.parse()
                const member = await membersRepo.fetch(username)
                return await member.startVerification(body) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/verification': {
                const member = await membersRepo.fetch(username)
                return await member.fetchVerificationStatus() satisfies Static<typeof req.route.success>
            }
            case "GET /tip/accounts": {
                const {query} = req.parse()
                const member = await membersRepo.fetch(username)
                const accounts = await member.fetchBankAccounts(query)
                return accounts satisfies Static<typeof req.route.success>
            }
            case "GET /tip/accounts/{id}": {
                const {path: {id}} = req.parse()
                const member = await membersRepo.fetch(username)
                const account = await member.fetchBankAccount(id)
                return account satisfies Static<typeof req.route.success>
            }
            case "POST /tip/accounts": {
                const {body} = req.parse()
                const member = await membersRepo.fetch(username)
                const account = await member.createBankAccount(body)
                return account satisfies Static<typeof req.route.success>
            }
            case "DELETE /tip/accounts/{id}": {
                const {path: {id}} = req.parse()
                const member = await membersRepo.fetch(username)
                const account = await member.deactivateBankAccount(id)
                return account satisfies Static<typeof req.route.success>
            }
        }
    })
