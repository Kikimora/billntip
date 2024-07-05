import {Static} from "@sinclair/typebox";
import {pipeline} from "@app/lambda";
import {SessionContextSchema} from "@src/authorizer/operation";
import Paths, {CreateEmptyImageResponse} from "./paths";
import uploads, {config} from "./uploads"

export type CreateUploadResponse = Static<typeof CreateEmptyImageResponse>

export async function __init() {
    return await config.load()
}

//1. Create upload with unique name like profile_pic_XYZ.
//2. Upload bytes.
//3. Have lambda function to dynamically resize image on request.
//4.

// Identity concept
// JWT token defines a set of objects and actions available to the bearer
// * Object id - group or object id
// * Tag - set of objects tagged with a claim.
// * List -

// 1. Organisation has a folder in files microservice.
//vs
// 2. Organisation API provides way to manage it files.

// 1. Auth service reads Db to pull org id for a user. Auth service needs access to all data stores.
// 2. API reads DB on each request to pull user details and authorize request.


// User Id - identity service, cookie, session context
// Claims - identity service
// OrgId to user map - orgs service
// 1. Present user id and request to access organisation as admin.
// 2.

// User (U) to identity: Give me token to manage organisation X
// Identity to Orgs: Give me claims for the user U and org X
// Identity to User: your token, sir
// User to Orgs: update organisation X.

// User (U) to identity: Give me token to manage files at X
// Identity to Files: Give me claims for the user U and directory X ????
//

// Corner case: data in one service implies access to data in another.
// Ex: If user admins an organisation in organisations service then she can manage files in org's folder in file service.
// Concern: tokens endpoint became a god endpoint with cryptic parameters combination.

//However: services owning data can certify access.
//BUT: if access is in ORGS and accessing files then what?

// Tokens service holds permissions.
// Membership service holds membership data, defines who owns what.
// Resource service holds resource to be updated.


//1. GET /token?scope=files&path=${orgid}&type=org
//1.1 lambda:InvokeLambda files-access-lambda: {uid:X, path:Y, type:org}
//1.2 Consult DynamoDB to find uid:X, org:Y pair
//1.3 Claims: { path:Y }
//2. POST /files/${orgid}

//1. GET /token?scope=orgs&id=${orgid}
//1.1 lambda:InvokeLambda orgs-access-lambda: {uid:X, id:Y}
//1.2 Consult DynamoDB to find uid:X, org:Y pair
//1.3 Claims: { org:Y, path:Y, role:admin }
//2. POST /files/${orgid}

//1. GET /tokens
// access_token: XYZ
//2. POST /images/${orgid}/logo
//   Authorization: Bearer XYZ
//2.1 Authorizer: map token to permissions
//What if permissions changed, or orgs list changes and it is embedded in the permissions?

//1. GET /tokens?scope=orgs
// lambda:InvokeLambda org-access-lambda
// access_token: {uid:X, path:Y, org:Y, type:org}
//2. POST /images/${orgid}/logo
//   Authorization: Bearer XYZ
//2.1 STD JWT Auth

//1. GET /token/org -> lambda:InvokeLambda org-access-lambda
// access_token: {uid:X, path:Y, org:Y, type:org}
//2. POST /images/${orgid}/logo
//   Authorization: Bearer XYZ
//2.1 STD JWT Auth


//1. POST /images/${orgid}/logo
//   Authorization: Bearer XYZ or Cookie
//2. Lookup

// claims - input into the authorization process, come from a trusted source.
//1. Service receive uid and maps it to claims
// Since this happens on every request, the service would want to cache claims data
// * Authorizer (up to 8Kb)
// * DAX or Redis
//2. User request claims from a token service and pass them to the service as a bearer token


// Assume we choose option 1 and see what happens when system changes.
// Let think of an orgs service that grants permissions to write org logo into a file store at specific path.
// File service defines claims it needs to authorize a request.
//
// 1. File service defines token structure and receives this token from user.
// 2. File service defines token structure and receives this token from authorizer provided by the orgs service.
// 3. File service uses Redis or DAX


export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .requireLambdaAuth(SessionContextSchema)
    .parseJsonBody()
    .withRoutes(Paths)
    .done(async function (req) {
        //TODO: owner can be user or organisation.
        const owner = req.principal.profile.sub
        switch (req.routeKey) {
            case 'GET /uploads': {
                const {query: {startKey}} = req.parse()
                const {files, lastKey} = await uploads.list(owner, "public", startKey)
                return {
                    lastKey,
                    files
                } satisfies Static<typeof req.route.success>
            }
            case 'GET /upload/{id}': {
                const {path: {id}} = req.parse()
                const {upload} = await uploads.read(owner, id, "public")
                return upload satisfies Static<typeof req.route.success>
            }
            case 'POST /uploads': {
                const {body: {type}} = req.parse()
                const {post, expires, id} = await uploads.prepare(owner, type, "uploads")
                return {
                    type: "profile_pic",
                    id: id,
                    uploadUrl: post.url,
                    uploadFields: post.fields,
                    expires: new Date(Date.now() + expires * 1000)
                } satisfies Static<typeof req.route.success>
            }
            case 'POST /upload/{id}': {
                const {path: {id}} = req.parse()
                //invalidate CloudFront cache ???
                const {upload, body} = await uploads.read(owner, id, "uploads")
                const {buffer, format, contentType, width, height} = await uploads.transform(upload.type, body)
                const newUpload = {
                    ...upload,
                    id: `${upload.type}.${format}`,
                    contentType,
                    image: {
                        width, height
                    }
                }
                return await uploads.save(owner, buffer, newUpload, "public") satisfies Static<typeof req.route.success>
            }
            case 'DELETE /upload/{id}': {
                const {path: {id}} = req.parse()
                await uploads.remove(owner, id, "public")
                return {
                    statusCode: 200
                }
            }
        }
    })
