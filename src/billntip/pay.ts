import {Static, Type} from "@sinclair/typebox";
import {badRequestError, bootstrap, notFoundError, pipeline} from "@app/lambda";
import diagnostics from "@app/diagnostics";
import TipUserRepo from "./user";
import Paths from "./pay-paths";
import {MangoPayUser} from "./mangopay-user";
import {MangopayAPI, MangopayOptions} from "./mangopay-api";
import {UserAttributeItem, UserStore as ProfileStore} from "@src/users/user";
import * as schemas from "./schemas";
import Store, {Org, UserItem} from "./store";
import _ from "lodash";
import {toLocation} from "@src/billntip/util";

const config = bootstrap()
    .parameters({
        mangopay: MangopayOptions,
        dynamodb: Type.Object({
            locks: Type.String(),
            users: Type.String(),
            data: Type.String()
        }),
        'pay-diagnostics': Type.Object({}, {relaxed: true, default: {triggers: {request: true}}})
    })
    .buildModule(({mangopay, dynamodb, 'pay-diagnostics': diagnasticsConfig}) => {
        diagnostics(diagnasticsConfig)
        return {mangopay, dynamodb}
    })

export function __init() {
    return config.exports
}

const DefaultTipSettings = {
    comment: true,
    payment_methods: new Set(schemas.CardType.anyOf.map(x => x.const)),
    questions: ["1", "2", "3"],
    tips: new Set([500, 1000, 1500]),
    type: "individual"
} as const satisfies Org['tip_settings']

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .withRoutes(Paths)
    .parseJsonBody()
    .done(async function (req) {
        const {mangopay, dynamodb} = await __init()
        const api = new MangopayAPI(mangopay)
        switch (req.routeKey) {
            case 'POST /pay/session': {
                const userId = await api.createPayerUser()
                return {
                    uid: userId
                }  satisfies Static<typeof req.route.success>
            }
            case "POST /pay/card": {
                const {body} = req.parse()
                const user = new MangoPayUser(api, {mangopayUid: body.payer})
                const card = await user.createEmptyCard(body)
                return card satisfies Static<typeof req.route.success>
            }
            case "PUT /pay/card": {
                const {body} = req.parse()
                const user = new MangoPayUser(api, {mangopayUid: body.payer})
                const card = await user.updateCard(body)
                return card satisfies Static<typeof req.route.success>
            }
            case "GET /pay/tip": {
                const {query} = req.parse()
                const recipients = createRecipientStore()
                const {org, location, recipient} = await recipients.fetchTipSettings(query)
                if (org === undefined || location === undefined || (query.recipient !== undefined && recipient === undefined))
                    throw notFoundError().withContext("fetch", {org, location, recipient})

                const tipSettings = _.defaults({}, location.tip_settings, org.tip_settings, DefaultTipSettings)

                if (tipSettings.type === 'individual' && recipient === undefined) {
                    throw badRequestError("Recipient is required").withContext("validate", {tipSettings})
                }

                async function recipientAttributes(recipient: UserItem | undefined) {
                    if (recipient !== undefined) {
                        const profiles = createProfileStore()
                        const {attributes} = await profiles.fetch(recipient.pk)
                        const isValidAttribute = function (x: UserAttributeItem): x is { name: string, value: string } {
                            return x.value !== undefined
                        }
                        return _(attributes)
                            .filter(isValidAttribute)
                            .keyBy('name')
                            .mapValues('value')
                            .value()
                    } else {
                        return {}
                    }
                }

                //TODO: profile picture and pictures in general
                //TODO: need_review: true | false
                //TODO: individual vs non-individual tips.

                const attrs = await recipientAttributes(recipient)
                req.tracer.info("User", {attrs: attrs, rec: recipient})
                return {
                    type: tipSettings.type,
                    currency: "EUR",
                    feedback: {
                        comment: tipSettings.comment,
                        questions: tipSettings.questions
                    },
                    location: toLocation(location),
                    organization: {
                        id: org.id,
                        title: org.title
                    },
                    payment_methods: Array.from(tipSettings.payment_methods) as schemas.TipSettings['payment_methods'],
                    recipient: {
                        type: "person",
                        id: recipient?.pk ?? "f6ae4220-1071-702d-f6ba-8c99280cb67b",
                        image: {
                            id: recipient?.pk ? `images/users/${recipient?.pk}.png` : "images/users/0fb5578a-8062-4ca8-8403-b548286f2ced.png",
                            version: 1
                        },
                        first_name: attrs['first_name'],
                        last_name: attrs['last_name'],
                        goal: {
                            description: attrs['wish'],
                            target: Number(attrs['money_goal']),
                            total: 200
                        }
                    },
                    tips: Array.from(tipSettings.tips).toSorted() as number[],
                } satisfies Static<typeof req.route.success>
            }
            case "POST /pay/tip": {
                const {body} = req.parse()
                const user = new MangoPayUser(api, {mangopayUid: body.payer})
                const recipients = createRecipientStore()
                const recipient = await recipients.fetchUser(body.recipient.id)
                if (recipient === undefined || recipient.walletId === undefined)
                    throw badRequestError("Invalid recipient")
                const walletId = recipient.walletId
                const response = await user.createTransaction(walletId, {
                    amount: body.amount,
                    currency: "EUR",
                    details: {
                        type: 'cc_payin',
                        card: body.payment_method,
                        auth_return_url: body.payment_auth_return_url,
                        browser_info: {
                            ...body.browser_info,
                            accept_header: req.headers['Accept'] ?? "application/json"
                        },
                        ip_address: req.requestContext.http.sourceIp
                    },
                }, JSON.stringify({
                    loc: body.location,
                    org: body.organization
                }))
                return {
                    banner: {
                        image: {id: "images/users/0fb5578a-8062-4ca8-8403-b548286f2ced.png", version: 1},
                        description: "This is a test description",
                        title: "Test Title",
                        href: "https://unitycoffee.pt/"
                    },
                    review_link: {
                        type: "google_map",
                        href: "https://maps.app.goo.gl/kjCTUCz8evUe7fsU8"
                    },
                    need_review: true,
                    tx: response
                } satisfies Static<typeof req.route.success>
            }

            case "GET /pay/tx": {
                const {query: {payer, id}} = req.parse()
                const user = new MangoPayUser(api, {mangopayUid: payer})
                const tx = await user.fetchTransaction(id)
                return tx satisfies Static<typeof req.route.success>
            }
        }

        function createRecipientsRepo() {
            const users = new ProfileStore({
                table: dynamodb.users
            })
            return new TipUserRepo({table: dynamodb.data}, mangopay, users)
        }

        function createRecipientStore() {
            return new Store({table: dynamodb.data})
        }

        function createProfileStore() {
            return new ProfileStore({table: dynamodb.users})
        }
    })
