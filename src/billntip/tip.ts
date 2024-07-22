import _ from "lodash";
import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {Static, Type} from "@sinclair/typebox";
import {moduleConfig, pipeline} from '@app/lambda'
import {SessionContextSchema} from "@src/authorizer/types";
import UserRepo from "@src/users/user";
import Paths from "./tip-paths";
import {toMembership} from "./util";
import TipUserRepo from "./user";
import diagnostics from "@app/diagnostics";
import {MangopayOptions} from "./mangopay-user";

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
        mangopay: MangopayOptions,
        'tip-diagnostics': Type.Object({}, {relaxed: true, default: {triggers: {request: true}}})
    })
    .build()

export function __init() {
    return config.parameters.then(({dynamodb, oidc, mangopay, 'tip-diagnostics': diagnostiocsConfig}) => {
        diagnostics(diagnostiocsConfig)

        const users = new UserRepo({
            db: dynamo,
            table: dynamodb.users,
            locks: dynamodb.locks
        })
        const tipUsers = new TipUserRepo({table: dynamodb.data}, mangopay)
        return {users, tipUsers, userPoolId: oidc.userPoolId}
    })
}

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .requireLambdaAuth(SessionContextSchema)
    .withRoutes(Paths)
    .parseJsonBody()
    .done(async function (req) {
        const {tipUsers, users, userPoolId} = await __init()
        const username = req.principal.id_token_json['cognito:username']
        switch (req.routeKey) {
            case 'POST /tip/registration': {
                const [user, member] = await Promise.all([
                    users.fetch(username),
                    tipUsers.fetchOrCreate(username)
                ])
                await member.refreshMangopayUser(user.attributes)
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
                const member = tipUsers.newUser(username)
                const membership = await member.acceptInvite(id)
                return toMembership(membership) satisfies Static<typeof req.route.success>
            }
            case 'DELETE /tip/invites/{id}': {
                const {path: {id}} = req.parse()
                const member = tipUsers.newUser(username)
                const membership = await member.rejectInvite(id)
                if (membership === undefined) return undefined
                return toMembership(membership) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/invites/{id}': {
                const {path: {id}} = req.parse()
                const member = tipUsers.newUser(username)
                const membership = await member.fetchMembership(id)
                return toMembership(membership) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/invites': {
                const {query} = req.parse()
                const member = tipUsers.newUser(username)
                const memberships = await member.memberships(query)
                return _.map(memberships, toMembership) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/me': {
                const member = await tipUsers.fetch(username)
                const mangopayUser = member.mangopayUser
                const [memberUser, status, wallet, verification] = await Promise.all([
                    mangopayUser.fetchUserInfo(),
                    mangopayUser.fetchRegulatoryStatus(),
                    mangopayUser.fetchWallet(),
                    mangopayUser.fetchVerificationDetails(),
                ])
                return {
                    kyc: {
                        level: memberUser.kycLevel,
                        evidence: {
                            ...verification
                        }
                    },
                    category: memberUser.category,
                    regulatory_status: status,
                    wallet: wallet.balance,
                    //deprecated, to be removed soon
                    kyc_level: memberUser.kycLevel,
                    proof_of_identity: memberUser.proofOfIdentity !== undefined,
                    proof_of_address: memberUser.proofOfAddress !== undefined,
                } satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/transactions': {
                const {query} = req.parse()
                const username = req.principal.id_token_json['cognito:username']
                const member = await tipUsers.fetch(username)
                const mangopayUser = member.mangopayUser
                const [transactions, wallet] = await Promise.all([
                    mangopayUser.transactions(query),
                    mangopayUser.fetchWallet(),
                ])
                return {
                    transactions,
                    wallet: wallet.balance
                } satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/transactions/{id}': {
                const {path:{id}} = req.parse()
                const username = req.principal.id_token_json['cognito:username']
                const member = await tipUsers.fetch(username)
                const mangopayUser = member.mangopayUser
                const [transaction, wallet] = await Promise.all([
                    mangopayUser.fetchTransaction(id),
                    mangopayUser.fetchWallet(),
                ])
                return {
                    transaction,
                    wallet: wallet.balance
                } satisfies Static<typeof req.route.success>
            }
            case 'POST /tip/transactions': {
                const {body} = req.parse()
                const username = req.principal.id_token_json['cognito:username']
                const member = await tipUsers.fetch(username)
                const mangopayUser = member.mangopayUser
                const transaction = await mangopayUser.createTransaction(body)
                //Fetch wallet after transaction to let it update
                const wallet = await mangopayUser.fetchWallet()
                return {
                    transaction,
                    wallet: wallet.balance
                } satisfies Static<typeof req.route.success>
            }
            case 'POST /tip/verification': {
                const {body} = req.parse()
                const member = await tipUsers.fetch(username)
                const mangopayUser = member.mangopayUser
                return await mangopayUser.startVerification(body) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/verification': {
                const member = await tipUsers.fetch(username)
                const mangopayUser = member.mangopayUser
                return await mangopayUser.fetchVerificationDetails() satisfies Static<typeof req.route.success>
            }
            case "GET /tip/accounts": {
                const {query} = req.parse()
                const member = await tipUsers.fetch(username)
                const mangopayUser = member.mangopayUser
                const accounts = await mangopayUser.fetchBankAccounts(query)
                return accounts satisfies Static<typeof req.route.success>
            }
            case "GET /tip/accounts/{id}": {
                const {path: {id}} = req.parse()
                const member = await tipUsers.fetch(username)
                const mangopayUser = member.mangopayUser
                const account = await mangopayUser.fetchBankAccount(id)
                return account satisfies Static<typeof req.route.success>
            }
            case "POST /tip/accounts": {
                const {body} = req.parse()
                const member = await tipUsers.fetch(username)
                const mangopayUser = member.mangopayUser
                const account = await mangopayUser.createBankAccount(body)
                return account satisfies Static<typeof req.route.success>
            }
            case "DELETE /tip/accounts/{id}": {
                const {path: {id}} = req.parse()
                const member = await tipUsers.fetch(username)
                const mangopayUser = member.mangopayUser
                const account = await mangopayUser.deactivateBankAccount(id)
                return account satisfies Static<typeof req.route.success>
            }
        }
    })
