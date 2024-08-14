import _ from "lodash";
import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {Context} from "aws-lambda";
import {SES} from "@aws-sdk/client-ses";
import {DynamoDB, TransactionCanceledException} from "@aws-sdk/client-dynamodb";
import {Static, Type} from "@sinclair/typebox";
import {
    accessDeniedError,
    badRequestError,
    internalError,
    LambdaAuthorizedRequest,
    Middleware,
    bootstrap,
    notFoundError,
    pipeline,
    registerDefaultFormats,
    TracedEvent
} from '@app/lambda'
import diagnostics, {errorWithContext, TraceAttributes, TracingOptions} from "@app/diagnostics";
import {SessionContext, SessionContextSchema} from "@src/authorizer/types";
import {TemplateRepo} from "@src/templates";
import UserRepo, {UserAttribute} from "@src/users/user";
import {generatePassword} from "@src/users/cognito";
import {keyToToken, tokenToKey, toLocation, toMembership} from "./util";
import Routes from "./bill-paths";
import Store, {InviteRequest, MembershipItem, Org} from "./store";

registerDefaultFormats()
const cognito = new CognitoIdentityProvider()
const dynamo = new DynamoDB()
const ses = new SES()

const Module = bootstrap()
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
    .buildModule(async function ({dynamodb, oidc, s3, 'bill-diagnostics': diag}) {
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

/**
 * Static initialisation.
 */
export function __init() {
    return Module.exports
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
                const {query: {startKey, locationId}, path: {orgId}} = req.parse()
                const org = await assertOrgAdmin(req.principal, orgId)
                let members: MembershipItem[]
                let lastKey: string | undefined
                if (locationId !== undefined) {
                    const memberIds = await store.locationMembers(orgId, locationId)
                    members = await store.batchGetMembers(memberIds)
                } else {
                    const orgMembers = await store.orgMembers(orgId, tokenToKey(startKey))
                    members = orgMembers.members
                    lastKey = keyToToken(orgMembers.lastKey)
                }
                const [users, invitees] = await Promise.all([
                    await userRepo.batchFetch(_(members).map('pk').uniq().valueOf()).then(x => _.keyBy(x, 'pk')),
                    await userRepo.batchFetch(_(members).map('invited_by').compact().uniq().valueOf()).then(x => _.keyBy(x, 'pk'))
                ])
                return {
                    members: members.map(function (member) {
                        const inviter = member.invited_by !== undefined ? invitees[member.invited_by] : undefined
                        return toMembership(member, org, users[member.pk], inviter)
                    }),
                    lastKey
                } satisfies Static<typeof req.route.success>
            }
            case 'POST /bill/{orgId}/members': {
                const {body, path: {orgId}} = req.parse()
                const inviterUsername = req.principal.id_token_json['cognito:username']
                const inviteeEmail = body.email;

                const org = await assertOrgAdmin(req.principal, orgId)
                const inviter = await userRepo.fetch(inviterUsername)
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

                const invite = {
                    role: 'member',
                    invited_by: invitedBy.username,
                    org: invitedTo,
                    username: inviteeUsername
                };

                const member = await createMember(invite)
                if (member === undefined)
                    throw internalError("Create member failed with unexpected error").withContext('createInvite', {
                        invite
                    })

                return toMembership(member, org, {
                    pk: inviteeUsername,
                    attributes: {'email': inviteeEmail}
                }, {
                    pk: inviter.username,
                    attributes: inviter.attributeMap
                }) satisfies Static<typeof req.route.success>
            }
            case 'GET /bill/{orgId}/members/{id}': {
                const {path: {orgId, id}} = req.parse()
                const org = await assertOrgAdmin(req.principal, orgId)

                const member = await fetchMembership(orgId, id)
                if (member === undefined) throw notFoundError()

                return await memberWithRelatedUsers(member, org, id) satisfies Static<typeof req.route.success>;
            }
            case 'DELETE /bill/{orgId}/members/{id}': {
                const {path: {orgId, id}} = req.parse()
                const org = await assertOrgAdmin(req.principal, orgId)
                const member = await removeMembership(orgId, id)
                if (member === undefined) throw notFoundError()
                return await memberWithRelatedUsers(member, org, id) satisfies Static<typeof req.route.success>;
            }
            case "PUT /bill/{orgId}/members/{id}": {
                const {path: {orgId, id}, body} = req.parse()
                const org = await assertOrgAdmin(req.principal, orgId)
                const member = await updateMembership(orgId, id, body)
                return await memberWithRelatedUsers(member, org, id) satisfies Static<typeof req.route.success>;
            }

            case "GET /bill/{orgId}/locations": {
                const {path: {orgId}, query} = req.parse()
                await assertOrgAdmin(req.principal, orgId)
                const {data, lastKey} = await store.locations(orgId, {
                    title: query.title,
                    archived: query.archived ?? false,
                    startKey: tokenToKey(query.start_key)
                })
                return {
                    lastKey: keyToToken(lastKey),
                    data: data.map(toLocation)
                } satisfies Static<typeof req.route.success>
            }
            case "GET /bill/{orgId}/locations/{id}": {
                const {path: {orgId, id}} = req.parse()
                await assertOrgAdmin(req.principal, orgId)
                const location = await store.location(orgId, id)
                if (location === undefined) throw notFoundError()
                return toLocation(location) satisfies Static<typeof req.route.success>
            }
            case "POST /bill/{orgId}/locations": {
                const {path: {orgId}, body} = req.parse()
                await assertOrgAdmin(req.principal, orgId)
                const location = await store.updateLocation(orgId, body)
                if (location === undefined) throw notFoundError()
                return toLocation(location) satisfies Static<typeof req.route.success>
            }
            case "PUT /bill/{orgId}/locations/{id}": {
                const {path: {orgId, id}, body} = req.parse()
                await assertOrgAdmin(req.principal, orgId)
                const location = await store.updateLocation(orgId, body, id)
                if (location === undefined) throw notFoundError()
                return toLocation(location) satisfies Static<typeof req.route.success>
            }
            case "PATCH /bill/{orgId}/locations/{id}": {
                const {path: {orgId, id}, body} = req.parse()
                await assertOrgAdmin(req.principal, orgId)
                if (body.addUser !== undefined && body.removeUser !== undefined)
                    throw badRequestError("Cannot add and remove user in the same query")

                const loc = await location(orgId, id)
                if (loc === undefined) throw notFoundError()

                if (body.addUser !== undefined) {
                    const member = await fetchMembership(orgId, body.addUser)
                    if (member === undefined) throw badRequestError("User is not a member of the organisation")
                    const location = await modifyUserLocation(orgId, id, body.addUser, 'add')
                    if (location === undefined) throw notFoundError()
                    return {
                        id: location.sk,
                        org_id: orgId,
                        user_id: location.pk
                    } satisfies Static<typeof req.route.success>
                }

                if (body.removeUser !== undefined) {
                    const location = await modifyUserLocation(orgId, id, body.removeUser, 'delete')
                    if (location === undefined) throw notFoundError()
                    return {
                        id: location.sk,
                        org_id: orgId,
                        user_id: location.pk
                    } satisfies Static<typeof req.route.success>
                }

                throw badRequestError("Request cannot be empty")
            }
            case "DELETE /bill/{orgId}/locations/{id}": {
                const {path: {orgId, id}} = req.parse()
                await assertOrgAdmin(req.principal, orgId)
                const location = await store.archiveLocation(orgId, id)
                if (location === undefined) throw notFoundError()
                return toLocation(location) satisfies Static<typeof req.route.success>
            }
        }

        async function memberWithRelatedUsers(member: MembershipItem, org: Org, id: string) {
            try {
                const [user, invitee] = await userRepo.batchFetch(_.compact([member.pk, member?.invited_by]))
                return toMembership(member, org, user, invitee) satisfies Static<typeof req.route.success>
            } catch (e: any) {
                throw internalError("Unexpected error").withContext("fetchRelatedUsers", {
                    org: org, id, cause: e
                })
            }
        }

        async function assertOrgAdmin(sessions: SessionContext, orgId: string) {
            const {isBusiness, isAdmin, groups} = principalGroups(sessions)
            if (isAdmin) {
                const org = await store.fetchOrg(orgId)
                if (org === undefined) throw notFoundError()
                return org
            } else if (isBusiness) {
                const org = await store.fetchOrg(orgId)
                if (org === undefined) throw notFoundError()
                const username = sessions.id_token_json['cognito:username'];
                const member = await store.fetchMembership(username, orgId)
                if (member === undefined || member.role != 'admin') {
                    throw accessDeniedError().withContext('assertOrgAdmin', {username, orgId, groups, member})
                }
                return org
            } else {
                throw accessDeniedError().withContext('assertOrgAdmin', {groups, orgId})
            }
        }

        function error(tag: string, ctx: TraceAttributes) {
            return internalError("Unexpected error").withContext(tag, ctx)
        }

        async function fetchMembership(orgId: string, uid: string) {
            try {
                return await store.fetchMembership(uid, orgId)
            } catch (e: any) {
                throw error("fetchMembership", {orgId, uid, cause: e})
            }
        }

        async function location(orgId: string, id: string) {
            try {
                return await store.location(orgId, id)
            } catch (e: any) {
                throw error("location", {orgId, id, cause: e})
            }
        }

        async function modifyUserLocation(orgId: string, locationId: string, uid: string, action: "add" | "delete") {
            try {
                return await store.modifyUserLocation(orgId, locationId, uid, action)
            } catch (e: any) {
                if (e.name === 'TransactionCanceledException') {
                    const message = "Organisation member does not exists, already has too many locations or location cannot accept more members";
                    throw badRequestError(message).withContext("modifyUserLocation", {
                        orgId, locationId, uid, action, cause: e
                    })
                }
                throw error("modifyUserLocation", {orgId, locationId, uid, action, cause: e})
            }
        }

        async function createMember(invite: InviteRequest) {
            try {
                return await store.inviteToOrg(invite)
            } catch (e: any) {
                switch (e.name) {
                    case 'ConditionalCheckFailedException': {
                        throw badRequestError('Member already exists').withContext('createInvite', {invite})
                    }
                    default:
                        throw error('createInvite', {invite, cause: e})
                }
            }
        }

        async function removeMembership(orgId: string, uid: string) {
            try {
                return await store.removeMembership(uid, orgId)
            } catch (e: any) {
                throw error('removeMembership', {orgId, uid, cause: e})
            }
        }

        async function updateMembership(orgId: string, uid: string, body: { role: "admin" | "member" }) {
            try {
                return await store.updateMembership(uid, orgId, body)
            } catch (e: any) {
                if (e.name === 'ConditionalCheckFailedException') {
                    throw notFoundError()
                }
                throw error('updateMembership', {orgId, uid, body, cause: e})
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
