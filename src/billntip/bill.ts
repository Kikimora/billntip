import _ from "lodash";
import {
    LambdaAuthorizedRequest,
    Middleware,
    pipeline,
    accessDeniedError,
    TracedEvent, internalServerError, badRequestError, notFoundError
} from '@app/lambda'
import {configure, errorWithContext} from "@app/diagnostics";
import {
    CognitoIdentityProvider,
    ListUsersCommand
} from "@aws-sdk/client-cognito-identity-provider";
import {SessionContext} from "@src/authorizer/session";
import {Context} from "aws-lambda";
import Routes from "./bill-paths";
import {die, toCamel} from "@app/util";
import Store from "./store";

const UserPoolId = process.env.USER_POOL_ID ?? die("USER_POOL_ID env variable is required")
const DataTableName = process.env.DATA_TABLE ?? die("DATA_TABLE required")

const cognito = new CognitoIdentityProvider()

configure({triggers: {request: true}})

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .requireLambdaAuth<SessionContext>()
    .withRoutes(Routes)
    .parseJsonBody()
    .do(async function (this: Middleware, e: TracedEvent, ctx: any) {
        const response = await this.next(e, ctx)
        //cleanup AWS noise
        delete response?.$metadata
        return toCamel(response)
    })
    .do(async function (this: Middleware, req: TracedEvent & LambdaAuthorizedRequest<SessionContext>, ctx: Context) {
        const user = req.user.profile
        const groups = user['cognito:groups']
        const isBusiness = _.includes(groups, 'business');
        const isAdmin = _.includes(groups, 'admin');
        req.tracer.info("User credentials", {groups, isBusiness, isAdmin})
        if (isBusiness || isAdmin) {
            return await this.next(req as any, ctx)
        }
        throw accessDeniedError()
    })
    .done(async function (req) {
        const store = new Store({table: DataTableName})

        switch (req.routeKey) {
            case 'GET /bill/{orgId}/invites': {
                const {body: {startKey}, path: {orgId}} = req.parse()
                const username = req.user.profile['cognito:username']
                await assertOrgAdmin(username, orgId)
                return await store.members(orgId, startKey)
            }
            case 'POST /bill/{orgId}/invite': {
                const {body, path: {orgId}} = req.parse()
                const inviterUsername = req.user.profile['cognito:username']
                const inviterEmail = req.user.profile['email']
                const inviteeEmail = body.email;

                req.tracer.info("Fetch inviter role")
                await assertOrgAdmin(inviterUsername, orgId)
                req.tracer.info("Fetch org info")
                const org = await store.orgInfo(orgId);
                if (org === undefined) {
                    throw notFoundError("Organisation does not exist.").withContext('orgInfo', {orgId})
                }
                req.tracer.info("Invite user")
                const inviteeUsername = await inviteUser(inviteeEmail, body.resend ?? false);
                if (inviteeUsername === undefined) {
                    throw internalServerError("Cannot create nor find user with a given email.")
                        .withContext('inviteUser', {inviteeEmail})
                }
                req.tracer.info("Create invite record in the db")
                const request = {
                    role: 'member',
                    invited_by: {
                        username: inviterUsername,
                        display_name: inviterEmail
                    },
                    org: {
                        id: orgId,
                        title: org.title ?? "NoName"
                    },
                    username: inviteeUsername
                };
                try {
                    await store.inviteMember(request)
                } catch (e: any) {
                    switch (e.name) {
                        case 'ConditionalCheckFailedException': {
                            throw badRequestError('Member already exists').withContext('createInvite', {
                                request
                            })
                        }
                        default:
                            throw errorWithContext(e, 'createInvite', {
                                request
                            })
                    }
                }

                return
            }
            case 'GET /bill/invite/{orgId}/{id}': {
                const {path: {orgId, id}} = req.parse()
                const username = req.user.profile['cognito:username']
                await assertOrgAdmin(username, orgId)
                return {id: orgId}
            }
            case 'DELETE /bill/invite/{orgId}/{id}': {
                const {path: {orgId, id}} = req.parse()
                const username = req.user.profile['cognito:username']
                await assertOrgAdmin(username, orgId)
                return {id: orgId}
            }
            case "PUT /bill/invite/{orgId}/{id}": {
                const {path: {orgId, id}} = req.parse()
                const username = req.user.profile['cognito:username']
                await assertOrgAdmin(username, orgId)
                return {id: "!!!!"}
            }
        }

        async function assertOrgAdmin(inviterUsername: string, orgId: string) {
            const inviterRole = await store.roleIn(inviterUsername, orgId)
            if (inviterRole != 'admin') {
                throw accessDeniedError().withContext('roleIn', {
                    inviterUsername,
                    org: orgId
                })
            }
        }
    })

/**
 * If user with a given email does not exist then send invite
 */
async function inviteUser(email: string, resend: boolean) {
    try {
        const response = await cognito.adminCreateUser({
            UserPoolId,
            Username: email,
            MessageAction: resend ? "RESEND" : undefined,
            UserAttributes: [{
                Name: 'email',
                Value: email
            }, {
                Name: 'email_verified',
                Value: 'true'
            }]
        })
        return response.User?.Username
    } catch (createUserError: any) {
        switch (createUserError.name) {
            //Cognito found that user with this username exists and confirmed
            case 'UnsupportedUserStateException':
            //PreSignup trigger found that user with this alias exists
            case 'UserLambdaValidationException': {
                try {
                    const {Users: users} = await cognito.listUsers({
                        UserPoolId,
                        AttributesToGet: ['email'],
                        Filter: `email = "${email}"`,
                        Limit: 1
                    })
                    return users?.[0]?.Username
                } catch (findUserError: any) {
                    throw errorWithContext(findUserError, 'listUsers', {
                        email,
                        adminCreateUser: createUserError.toString(),
                    })
                }
            }
            default:
                throw errorWithContext(createUserError, 'adminCreateUser', {email})
        }

    }
}

