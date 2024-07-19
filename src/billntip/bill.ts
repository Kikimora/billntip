import _ from "lodash";
import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {Context} from "aws-lambda";
import {SES} from "@aws-sdk/client-ses";
import {
    LambdaAuthorizedRequest,
    Middleware,
    pipeline,
    accessDeniedError,
    TracedEvent, internalError, badRequestError, notFoundError, moduleConfig
} from '@app/lambda'
import diagnostics, {errorWithContext, TracingOptions} from "@app/diagnostics";
import {SessionContext, SessionContextSchema} from "@src/authorizer/types";
import {toCamelCase} from "@app/util";
import {keyToToken, tokenToKey, toMembership} from "./util";
import Routes from "./bill-paths";
import Store, {InviteRequest} from "./store";
import {TemplateRepo} from "@src/templates";
import UserRepo, {UserAttribute} from "@src/users/user";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {Static, Type} from "@sinclair/typebox";
import {generatePassword} from "@src/users/cognito";

const cognito = new CognitoIdentityProvider()
const dynamo = new DynamoDB()
const ses = new SES()

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
        s3: Type.Object({
            bucket: Type.String()
        }),
        'bill-diagnostics': Type.Object({}, {relaxed: true, default: {triggers: {request: true}}})
    })
    .build()

/**
 * Static initialisation.
 */
export function __init() {
    return config.parameters.then(async function ({dynamodb, oidc, s3, 'bill-diagnostics': diag}) {
        const userRepo = new UserRepo({
            db: dynamo,
            table: dynamodb.users,
            locks: dynamodb.locks
        })

        const templates = new TemplateRepo({
            bucket: s3.bucket,
            cache: process.env.ENV === 'prod'
        })

        const store = new Store({table: dynamodb.data})

        diagnostics(diag as TracingOptions)

        return {
            userPoolId: oidc.userPoolId,
            templates,
            userRepo,
            store
        }
    })
}

function principalGroups(s: SessionContext) {
    const user = s.id_token_json
    const groups = user['cognito:groups'] ?? []
    const isBusiness = _.includes(groups, 'business');
    const isAdmin = _.includes(groups, 'admin');
    return {isBusiness, isAdmin, groups}
}

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .requireLambdaAuth(SessionContextSchema)
    .withRoutes(Routes)
    .parseJsonBody()
    .do(async function (this: Middleware, e: TracedEvent, ctx: any) {
        const response = await this.next(e, ctx)
        //cleanup AWS noise
        delete response?.$metadata
        return toCamelCase(response)
    })
    .do(async function (this: Middleware, req: TracedEvent & LambdaAuthorizedRequest<SessionContext>, ctx: Context) {
        const {isBusiness, isAdmin, groups} = principalGroups(req.principal)
        req.tracer.info("User credentials", {groups, isBusiness, isAdmin})
        if (isBusiness || isAdmin) {
            return await this.next(req as any, ctx)
        }
        throw accessDeniedError()
    })
    .done(async function (req) {
        const {store, userRepo, userPoolId, templates} = await __init()

        switch (req.routeKey) {
            case 'GET /bill/{orgId}/members': {
                const {query: {startKey}, path: {orgId}} = req.parse()
                await assertOrgAdmin(req.principal, orgId)
                const {members, lastKey} = await store.orgMembers(orgId, tokenToKey(startKey))
                return {
                    members: members?.map(toMembership) ?? [],
                    lastKey: keyToToken(lastKey)
                } satisfies Static<typeof req.route.success>
            }
            case 'POST /bill/{orgId}/members': {
                const {body, path: {orgId}} = req.parse()
                const inviterUsername = req.principal.id_token_json['cognito:username']
                const inviteeEmail = body.email;

                await assertOrgAdmin(req.principal, orgId)
                const inviter = await userRepo.fetch(inviterUsername)

                const org = await store.fetchOrg(orgId);
                if (org === undefined) {
                    throw notFoundError("Organisation does not exist.").withContext('orgInfo', {orgId})
                }
                const invitedBy = {
                    username: inviter.username,
                    email: inviter.attr('email', true) ?? '',
                    first_name: inviter.attr('first_name') ?? '',
                    last_name: inviter.attr('last_name') ?? '',
                }
                const invitedTo = {
                    id: orgId,
                    title: org.title ?? "NoName"
                }
                const inviteeUsername = await inviteUser(inviteeEmail, {
                    ..._.mapKeys(invitedBy, (_1, key) => `invited_by_${key}`),
                    ..._.mapKeys(invitedTo, (_1, key) => `org_${key}`),
                    env: process.env.ENV ?? "dev"
                });
                if (inviteeUsername === undefined) {
                    throw internalError("Cannot create nor find user with a given email.")
                        .withContext('inviteUser', {inviteeEmail})
                }

                async function createMember(invite: InviteRequest) {
                    try {
                        return await store.inviteToOrg(invite)
                    } catch (e: any) {
                        switch (e.name) {
                            case 'ConditionalCheckFailedException': {
                                throw badRequestError('Member already exists').withContext('createInvite', {
                                    invite
                                })
                            }
                            default:
                                throw errorWithContext(e, 'createInvite', {
                                    invite
                                })
                        }
                    }
                }

                const invite = {
                    role: 'member',
                    invited_by: invitedBy,
                    org: invitedTo,
                    username: inviteeUsername
                };

                const member = await createMember(invite)
                if (member === undefined)
                    throw internalError("Create member failed with unexpected error").withContext('createInvite', {
                        invite
                    })

                return toMembership(member) satisfies Static<typeof req.route.success>
            }
            case 'GET /bill/{orgId}/members/{id}': {
                const {path: {orgId, id}} = req.parse()
                await assertOrgAdmin(req.principal, orgId)
                const member = await store.fetchMembership(id, orgId)
                if (member === undefined) throw notFoundError()
                return toMembership(member) satisfies Static<typeof req.route.success>
            }
            case 'DELETE /bill/{orgId}/members/{id}': {
                const {path: {orgId, id}} = req.parse()
                await assertOrgAdmin(req.principal, orgId)
                const member = await store.removeMembership(id, orgId)
                if (member === undefined) throw notFoundError()
                return toMembership(member) satisfies Static<typeof req.route.success>
            }
            case "PUT /bill/{orgId}/members/{id}": {
                const {path: {orgId, id}, body} = req.parse()
                await assertOrgAdmin(req.principal, orgId)

                const member = await store.updateMembership(id, orgId, body)
                if (member === undefined) throw notFoundError()
                return toMembership(member) satisfies Static<typeof req.route.success>
            }
        }

        async function assertOrgAdmin(sessions: SessionContext, orgId: string) {
            const {isBusiness, isAdmin, groups} = principalGroups(sessions)
            if (isAdmin) return
            const username = sessions.id_token_json['cognito:username'];
            const member = await store.fetchMembership(username, orgId)
            if (!isBusiness || member?.role != 'admin') {
                throw accessDeniedError().withContext('assertOrgAdmin', {username, orgId, groups})
            }
        }

        /**
         * If user with a given email does not exist then send invite
         */
        async function inviteUser(email: string, metadata: Record<string, string>) {
            const user = await fetchUser(email)
            const attributes = userRepo.normalAttributes(user?.attributes ?? [])
            const context = {
                username: user?.username,
                email,
                attributes,
                metadata
            }
            try {
                const resend = user !== undefined
                const username = await adminCreateUser(email, resend, attributes, metadata)
                if (user === undefined) {
                    await userRepo.create(username, "trusted", [{name: "email", value: email, verified: true}])
                }
                return username
            } catch (createUserError: any) {
                const userConfirmed = user !== undefined && createUserError.name === 'UnsupportedUserStateException';
                if (!userConfirmed)
                    throw errorWithContext(createUserError, 'adminCreateUser', context)

                try {
                    await sendInviteMessage(user.username, email, attributes, metadata)
                    return user.username
                } catch (sendInviteError: any) {
                    throw errorWithContext(sendInviteError, 'sendInviteMessage', {
                        ...context,
                        adminCreateUser: createUserError.toString(),
                    })
                }
            }
        }

        async function fetchUser(email: string) {
            try {
                return await userRepo.fetch(email, {allowUnverifiedAlias: true})
            } catch (e: any) {
                if (e.name === 'UserNotFoundException') {
                    return undefined
                }
                throw e
            }
        }

        async function adminCreateUser(email: string, resend: boolean, attributes: UserAttribute[], metadata: Record<string, string>) {
            const password = await generatePassword(userPoolId)
            const response = await cognito.adminCreateUser({
                UserPoolId: userPoolId,
                Username: email,
                MessageAction: resend ? "RESEND" : undefined,
                UserAttributes: [{
                    Name: 'email',
                    Value: email
                }, {
                    Name: 'email_verified',
                    Value: 'true'
                }],
                TemporaryPassword: password,
                ClientMetadata: {
                    ...metadata,
                    _attributes: JSON.stringify(attributes),
                    password
                }
            })
            if (response.User?.Username === undefined) throw internalError("adminCreateUser didn't return username.")
            return response.User.Username
        }

        async function sendInviteMessage(username: string, email: string, attributes: UserAttribute[], metadata: Record<string, string>) {
            //User with this username exists and confirmed
            const template = await templates.fetchTemplate("admin-create-user-email.html")
            await ses.sendEmail({
                Source: "no-reply@billntip.com",
                Destination: {ToAddresses: [email]},
                Message: {
                    Body: {
                        Html: {
                            Charset: "utf8",
                            Data: template({
                                attributes: _(attributes)
                                    .filter(x => x.verified || x.verified === undefined)
                                    .keyBy('name')
                                    .mapValues('value')
                                    .value(),
                                metadata,
                                username: username,
                                code: "",
                                link: "",
                                type: "invite"
                            })
                        }
                    },
                    Subject: {
                        Charset: "utf-8",
                        Data: `${metadata['invited_by_first_name']} invited you to join the ${metadata['org_title']} team on Bill&Tip`
                    }
                }
            })
        }
    })
