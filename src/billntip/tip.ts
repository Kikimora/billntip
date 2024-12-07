import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {Static, Type} from "@sinclair/typebox";
import {accessDeniedError, bootstrap, pipeline, registerDefaultFormats} from '@app/lambda'
import {SessionContextSchema} from "@src/authorizer/types";
import {UserStore as ProfileStore} from "@src/users/user";
import Paths from "./tip-paths";
import TipUserRepo from "./user";
import diagnostics from "@app/diagnostics";
import {MangopayOptions} from "./mangopay-api";

registerDefaultFormats()
const dynamo = new DynamoDB()
const cognito = new CognitoIdentityProvider()
const GroupName = 'recipient';

const config = bootstrap()
    .parameters({
        dynamodb: Type.Object({
            users: Type.String(),
            data: Type.String()
        }),
        oidc: Type.Object({
            userPoolId: Type.String(),
        }),
        mangopay: MangopayOptions,
        'tip-diagnostics': Type.Object({}, {relaxed: true, default: {triggers: {request: true}}})
    })
    .buildModule(({dynamodb, oidc, mangopay, 'tip-diagnostics': diagnostiocsConfig}) => {
        diagnostics(diagnostiocsConfig)
        const users = new ProfileStore({
            db: dynamo,
            table: dynamodb.users
        })
        const tipUsers = new TipUserRepo({table: dynamodb.data}, mangopay, users)
        return {users, tipUsers, userPoolId: oidc.userPoolId}
    })

export function __init() {
    return config.exports
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
            case 'POST /tip/registration':
                break
            default:
                assertRecipient()
        }

        switch (req.routeKey) {
            case 'POST /tip/registration': {
                const [user, tipUser] = await Promise.all([
                    users.fetch(username),
                    tipUsers.fetchOrCreate(username)
                ])
                await tipUser.refreshMangopayUser(user.attributes)
                const [_1, _2, invites] = await Promise.all([
                    tipUser.save(),
                    cognito.adminAddUserToGroup({
                        GroupName,
                        Username: username,
                        UserPoolId: userPoolId
                    }),
                    tipUser.memberships({accepted: false, rejected: false})
                ])
                return {invites} satisfies Static<typeof req.route.success>
            }
            case 'PUT /tip/organisations/{id}': {
                const {path: {id}} = req.parse()
                const user = tipUsers.newUser(username)
                const membership = await user.acceptInvite(id)
                return membership satisfies Static<typeof req.route.success>
            }
            case 'DELETE /tip/organisations/{id}': {
                const {path: {id}} = req.parse()
                const user = tipUsers.newUser(username)
                const membership = await user.rejectInvite(id)
                if (membership === undefined) return undefined
                return membership satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/organisations/{id}': {
                const {path: {id}} = req.parse()
                const user = tipUsers.newUser(username)
                const membership = await user.fetchMembership(id)
                return membership satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/organisations': {
                const {query} = req.parse()
                const user = tipUsers.newUser(username)
                const memberships = await user.memberships(query)
                return memberships satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/me': {
                const member = await tipUsers.fetch(username)
                const mangopayUser = member.mangopayUser
                const [userInfo, status, wallet, verification] = await Promise.all([
                    mangopayUser.fetchUserInfo(),
                    mangopayUser.fetchRegulatoryStatus(),
                    mangopayUser.defaultWallet.fetch(),
                    mangopayUser.fetchVerificationDetails(),
                ])
                return {
                    kyc: {
                        level: userInfo.kycLevel,
                        evidence: {
                            ...verification
                        }
                    },
                    category: userInfo.category,
                    regulatory_status: status,
                    wallet: {
                        amount: wallet.amount,
                        currency: wallet.currency,
                        pending: wallet.pending,
                    },
                    //deprecated, to be removed soon
                    kyc_level: userInfo.kycLevel,
                    proof_of_identity: userInfo.proofOfIdentity !== undefined,
                    proof_of_address: userInfo.proofOfAddress !== undefined,
                } satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/transactions': {
                const {query} = req.parse()
                const username = req.principal.id_token_json['cognito:username']
                const user = await tipUsers.fetch(username)
                const mangopayUser = user.mangopayUser
                const wallet = await mangopayUser.defaultWallet.fetch()
                const transactions = await mangopayUser.defaultWallet.transactions(query)
                return {
                    transactions,
                    page: query.page ?? 1,
                    per_page: query.per_page ?? 10,
                    wallet: {
                        amount: wallet.amount,
                        currency: wallet.currency,
                        pending: wallet.pending,
                    }
                } satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/transactions/{id}': {
                const {path: {id}} = req.parse()
                const username = req.principal.id_token_json['cognito:username']
                const user = await tipUsers.fetch(username)
                const mangopayUser = user.mangopayUser
                const [transaction, wallet] = await Promise.all([
                    mangopayUser.fetchTransaction(id),
                    mangopayUser.defaultWallet.fetch(),
                ])
                return {
                    transaction,
                    wallet: {
                        amount: wallet.amount,
                        currency: wallet.currency,
                        pending: wallet.pending,
                    }
                } satisfies Static<typeof req.route.success>
            }
            case 'POST /tip/transactions': {
                const {body} = req.parse()
                const username = req.principal.id_token_json['cognito:username']
                const user = await tipUsers.fetch(username)
                const mangopayUser = user.mangopayUser
                const transaction = await mangopayUser.defaultWallet.createTransaction(body, user.username)
                //Fetch wallet after transaction to let it update
                const wallet = await mangopayUser.defaultWallet.fetch()
                return {
                    transaction,
                    wallet: {
                        amount: wallet.amount,
                        currency: wallet.currency,
                        pending: wallet.pending,
                    }
                } satisfies Static<typeof req.route.success>
            }
            case 'POST /tip/verification': {
                const {body} = req.parse()
                const member = await tipUsers.fetch(username)
                const mangopayUser = member.mangopayUser
                return await mangopayUser.startVerification(body) satisfies Static<typeof req.route.success>
            }
            case 'GET /tip/verification': {
                const user = await tipUsers.fetch(username)
                const mangopayUser = user.mangopayUser
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
                const user = await tipUsers.fetch(username)
                const mangopayUser = user.mangopayUser
                const account = await mangopayUser.fetchBankAccount(id)
                return account satisfies Static<typeof req.route.success>
            }
            case "POST /tip/accounts": {
                const {body} = req.parse()
                const user = await tipUsers.fetch(username)
                const mangopayUser = user.mangopayUser
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
            case "GET /tip/locations": {
                const user = await tipUsers.fetch(username)
                const locations = await user.fetchLocations()
                return locations.map(function (loc) {
                    return {
                        id: loc.sk,
                        org_id: loc.pk,
                        image: loc.image,
                        archived: loc.deleted ?? false,
                        created_at: loc.created_at ?? 0,
                        title: loc.title ?? "Unknown",
                        updated_at: loc.updated_at ?? 0,
                    }
                }) satisfies Static<typeof req.route.success>
            }
        }

        function assertRecipient() {
            const groups = req.principal.id_token_json['cognito:groups'] ?? []
            const recipients = groups.find(function (group) {
                return group === GroupName
            })
            if (recipients === undefined)
                throw accessDeniedError().withContext('assertOrgAdmin', {username, groups})
        }
    })
