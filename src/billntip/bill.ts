import _ from "lodash";
import {Context} from "aws-lambda";
import {DynamoDB} from "@aws-sdk/client-dynamodb";
import {Static, Type} from "@sinclair/typebox";
import {
    accessDeniedError,
    badRequestError,
    bootstrap,
    internalError,
    LambdaAuthorizedRequest,
    Middleware,
    notFoundError,
    pipeline,
    registerDefaultFormats,
    TracedEvent
} from '@app/lambda'
import diagnostics, {TraceAttributes, TracingOptions} from "@app/diagnostics";
import {SessionContext, SessionContextSchema} from "@src/authorizer/types";
import {TemplateRepo} from "@src/templates";
import ProfileRepo from "@src/users/user";
import {toLocation, toMembership} from "./util";
import Routes from "./bill-paths";
import * as schemas from "./schemas";
import Store, {MemberItem, Org} from "./store";
import {S3Object, uploadBuilder} from "@src/object-store";
import {uuid} from "@app/util";
import * as members from "./members"

registerDefaultFormats()
const dynamo = new DynamoDB()

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
            bucket: Type.String(),
            tmpPrefix: Type.String({default: "/tmp"})
        }),
        'bill-diagnostics': Type.Object({}, {relaxed: true, default: {triggers: {request: true}}})
    })
    .buildModule(async function ({dynamodb, oidc, s3, 'bill-diagnostics': diag}) {
        const profileRepoOptions = {
            db: dynamo,
            table: dynamodb.users,
            locks: dynamodb.locks
        };
        const profileRepo = new ProfileRepo(profileRepoOptions)

        const templateRepoOptions = {
            bucket: s3.bucket,
            cache: process.env.ENV === 'prod'
        };
        const templates = new TemplateRepo(templateRepoOptions)

        const store = new Store({table: dynamodb.data})

        const repo = new members.Repo(dynamodb.data, profileRepo)

        diagnostics(diag as TracingOptions)

        return {
            userPoolId: oidc.userPoolId,
            templates,
            profileRepo,
            profileRepoOptions,
            templateRepoOptions,
            store,
            repo,
            s3
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

function error(tag: string, ctx: TraceAttributes) {
    return internalError("Unexpected error").withContext(tag, ctx)
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
        const context = await __init()
        const {repo, store, profileRepo, s3} = context
        const username = req.principal.id_token_json['cognito:username']
        switch (req.routeKey) {

            case 'GET /admin/organizations': {
                await assertAdmin(req.principal)
                const {query: {from}} = req.parse()
                return await repo.organizations({cursor: from}) satisfies Static<typeof req.route.success>
            }
            case 'GET /bill/organizations': {
                const {isAdmin} = await assertAdminOrBusiness(req.principal)
                const {query: {from}} = req.parse();
                const response = await repo.organizations({cursor: from, username: isAdmin ? undefined : username});
                return response satisfies Static<typeof req.route.success>
            }
            case 'GET /bill/{orgId}/members': {
                const {query, path: {orgId}} = req.parse()
                const org = await assertOrgAdmin(req.principal, orgId)
                const organization = repo.organization(org)
                return await organization.members(query) satisfies Static<typeof req.route.success>
            }
            case 'POST /bill/{orgId}/members': {
                const {body, path: {orgId}} = req.parse()
                const org = await assertOrgAdmin(req.principal, orgId)
                const organization = repo.organization(org)
                const inviter = organization.newMember(username)
                await inviter.fetchProfile(true)
                const service = new members.Service({
                    profileRepo: context.profileRepoOptions,
                    templates: context.templateRepoOptions,
                    userPoolId: context.userPoolId
                })
                const newMember = await service.inviteMember(inviter, body.email)
                return members.Response.buildFromMember(newMember, inviter.profile) satisfies Static<typeof req.route.success>
            }
            case 'GET /bill/{orgId}/members/{id}': {
                const {path: {orgId, id}} = req.parse()
                const org = await assertOrgAdmin(req.principal, orgId)
                const organization = repo.organization(org)
                const member = await organization.fetchMember(id)
                const locations = await member.locations()
                await member.fetchRelatedProfiles()
                return {
                    member: members.Response.buildFromMember(member),
                    locations: locations.map(toLocation)
                } satisfies Static<typeof req.route.success>;
            }
            case 'DELETE /bill/{orgId}/members/{id}': {
                const {path: {orgId, id}} = req.parse()
                const org = await assertOrgAdmin(req.principal, orgId)
                const organization = repo.organization(org)
                const member = organization.newMember(id)
                await member.fetchRelatedProfiles()
                if (!await member.delete()) {
                    throw notFoundError()
                }
                return members.Response.buildFromMember(member) satisfies Static<typeof req.route.success>;
            }
            case "PUT /bill/{orgId}/members/{id}": {
                const {path: {orgId, id}, body} = req.parse()
                const org = await assertOrgAdmin(req.principal, orgId)
                const organization = repo.organization(org)
                const member = organization.newMember(id)
                await Promise.all([
                    member.update(body),
                    member.fetchRelatedProfiles()
                ])
                return members.Response.buildFromMember(member) satisfies Static<typeof req.route.success>
            }

            case "GET /bill/{orgId}/locations": {
                const {path: {orgId}, query} = req.parse()
                const org = await assertOrgAdmin(req.principal, orgId)
                const organization = repo.organization(org)
                return await organization.locations(query) satisfies Static<typeof req.route.success>
            }
            case "GET /bill/{orgId}/locations/{id}": {
                const {path: {orgId, id}} = req.parse()
                const org = await assertOrgAdmin(req.principal, orgId)
                const organization = repo.organization(org)

                const [location, {members}] = await Promise.all([
                    organization.fetchLocation(id),
                    organization.members({location: id})
                ])
                if (location === undefined) throw notFoundError()
                return {location, members} satisfies Static<typeof req.route.success>
            }
            case "POST /bill/{orgId}/locations": {
                const {path: {orgId}, body} = req.parse()
                await assertOrgAdmin(req.principal, orgId)
                const locId = uuid.generate()
                const image = await prepareUpload(orgId, locId, 'image', body)
                const newLocation = await store.updateLocation(orgId, body, locId, "create")
                if (newLocation === undefined) throw internalError()
                if (image !== undefined && body.image !== undefined) {
                    await image.upload.move(body.image.id)
                }
                return toLocation(newLocation) satisfies Static<typeof req.route.success>
            }
            case "POST /bill/{orgId}/locations/image": {
                const {path: {orgId}} = req.parse()
                await assertOrgAdmin(req.principal, orgId)
                const upload = uploadBuilder(`${orgId}/${req.principal.id}.png`, {
                    bucket: s3.bucket,
                    prefix: s3.tmpPrefix
                })
                    .condition(["content-length-range", 1024, 5 * 1024 * 1024])
                    .condition(["starts-with", "$Content-Type", "image/"])
                    .properties({
                        'type': 'location_image',
                        'owner': req.principal.id,
                        'org': orgId,
                        //'destination': `${orgId}/${}`,
                        'transform': 'resize',
                        'target-width': '100',
                        'target-height': '100',
                        'target-format': 'png'
                    })
                return await upload.build() satisfies Static<typeof req.route.success>
            }
            case "PUT /bill/{orgId}/locations/{id}": {
                const {path: {orgId, id}, body} = req.parse()
                await assertOrgAdmin(req.principal, orgId)
                const image = await prepareUpload(orgId, id, 'image', body)
                const location = await store.updateLocation(orgId, body, id, "update")
                if (location === undefined) throw notFoundError()
                if (image !== undefined && body.image !== undefined) {
                    await image.upload.move(body.image.id)
                }
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

        async function membersWithRelatedUsers(org: Org, memberItems: MemberItem[]) {
            try {
                const [users, invitees] = await Promise.all([
                    await profileRepo.batchFetch(_(memberItems).map('id').uniq().valueOf()).then(x => _.keyBy(x, 'id')),
                    await profileRepo.batchFetch(_(memberItems).map('invited_by').compact().uniq().valueOf()).then(x => _.keyBy(x, 'id'))
                ])
                return memberItems.map(function (member) {
                    const inviter = member.invited_by !== undefined ? invitees[member.invited_by] : undefined
                    return toMembership(member, org, users[member.id], inviter)
                });
            } catch (e: any) {
                throw error("membersWithRelatedUsers", {org, memberItems})
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

        async function assertAdmin(sessions: SessionContext) {
            const {isAdmin} = principalGroups(sessions)
            if (!isAdmin) {
                throw accessDeniedError()
            }
        }

        async function assertAdminOrBusiness(sessions: SessionContext) {
            const {isAdmin, isBusiness} = principalGroups(sessions)
            if (!isAdmin && !isBusiness) {
                throw accessDeniedError()
            }
            return {isAdmin, isBusiness}
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

        async function prepareUpload<K extends string, T extends Partial<Record<K, schemas.Image | undefined>>>(orgId: string, locId: string, key: K, body: T) {
            const image = body[key]
            if (image === undefined) return undefined
            const upload = new S3Object(s3.bucket, image.id)
            const metadata = await upload.head().returnNothingIfNotFound()
            if (metadata === undefined || metadata.props.type !== 'location_image' || metadata.props.org !== orgId) {
                throw badRequestError("Invalid image key", {
                    path: (`/${key}`)
                })
            }
            image.version = Date.now()
            image.id = `/images/${orgId}/locations/${locId}.${upload.keyExt}`
            return {upload, image}
        }
    })
