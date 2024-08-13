import {SES} from "@aws-sdk/client-ses";
import {Type} from "@sinclair/typebox";
import {internalError, bootstrap, pipeline} from "@app/lambda";
import diagnostics from "@app/diagnostics";
import {MangopayAPI, MangopayOptions} from "./mangopay-user";
import Paths from "./mangopay-hooks-paths";
import {TemplateRepo} from "@src/templates";
import UserRepo from "@src/users/user";
import {KYCProcess} from "@src/billntip/schemas";

const ses = new SES()
const config = bootstrap()
    .parameters({
        dynamodb: Type.Object({
            locks: Type.String(),
            users: Type.String(),
            data: Type.String()
        }),
        s3: Type.Object({bucket: Type.String()}),
        mangopay: MangopayOptions,
        'tip-diagnostics': Type.Object({}, {relaxed: true, default: {triggers: {request: true}}})
    })
    .buildModule(({dynamodb, s3, mangopay, 'tip-diagnostics': diagnosticsConfig}) => {
        diagnostics(diagnosticsConfig)
        const templates = new TemplateRepo({
            bucket: s3.bucket,
            cache: process.env.ENV === 'prod'
        })
        const users = new UserRepo({
            table: dynamodb.users,
            locks: dynamodb.locks
        })
        const api = new MangopayAPI(mangopay)
        return {mangopay, templates, users, api}
    })

export function __init() {
    return config.exports
}

export const handler = pipeline()
    .do(async function (req: any, ctx: any) {
        try {
            return await this.next(req, ctx)
        } catch (e) {
            return {
                statusCode: 200
            }
        }
    })
    .traceRequest()
    .withRoutes(Paths)
    .done(async function (req) {
        const {api, templates, users} = await __init()

        switch (req.routeKey) {
            case 'GET /tip/mangopay/callback': {
                const {query} = req.parse()
                switch (query.EventType) {
                    case 'KYC_VALIDATION_ASKED': {
                        const rid = query.RessourceId
                        const doc = await api.fetchKYCDocument(rid)
                        const uid = kycDocHasUid(doc)
                        if (uid === undefined) return
                        await sendEmail(uid, "kyc-started-email.html", `Your Bill&Tip account is in review.`, doc)
                        break
                    }
                    case 'KYC_SUCCEEDED': {
                        const rid = query.RessourceId
                        const doc = await api.fetchKYCDocument(rid)
                        const uid = kycDocHasUid(doc)
                        if (uid === undefined) return
                        await sendEmail(uid, "kyc-succeeded-email.html", `Account verification successfully completed.`, doc)
                        break
                    }
                    case 'KYC_OUTDATED': {
                        const rid = query.RessourceId
                        const doc = await api.fetchKYCDocument(rid)
                        const uid = kycDocHasUid(doc)
                        if (uid === undefined) return
                        await sendEmail(uid, "kyc-outdated-email.html", `Additional account verification required.`, doc)
                        break
                    }
                    case 'KYC_FAILED': {
                        const rid = query.RessourceId
                        const doc = await api.fetchKYCDocument(rid)
                        const uid = kycDocHasUid(doc)
                        if (uid === undefined) return
                        await sendEmail(uid, "kyc-failed-email.html", `Account verification failed.`, doc)
                        break
                    }
                }

                return query
            }
        }

        function kycDocHasUid(doc: KYCProcess) {
            if (doc.tag === undefined) {
                throw internalError("KYC document does not have a tag with user id. Ignore callback.")
                    .withContext("kycDocHasUid", {doc})
            }
            return doc.tag
        }

        async function sendEmail(uid: string, templateName: string, title: string, doc: KYCProcess) {
            const user = await users.fetch(uid)
            const username = user.username
            const attributes = users.normalAttributes(user.attributes ?? [])
            const metadata = {
                env: process.env.ENV ?? "dev",
                ...doc
            }
            const email = user.attributeMap['email']
            if (email === undefined)
                throw internalError("User does not have an email.")
                    .withContext("sendEmail", {user: user.attributes})

            const template = await templates.fetchTemplate(templateName)
            await ses.sendEmail({
                Source: "no-reply@billntip.com",
                Destination: {ToAddresses: [email]},
                Message: {
                    Body: {
                        Html: {
                            Charset: "utf8",
                            Data: template({
                                attributes,
                                metadata,
                                username
                            })
                        }
                    },
                    Subject: {
                        Charset: "utf-8",
                        Data: title
                    }
                }
            })
        }
    })