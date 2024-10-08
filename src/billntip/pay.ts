import {Static, Type} from "@sinclair/typebox";
import {badRequestError, bootstrap, notFoundError, pipeline} from "@app/lambda";
import diagnostics from "@app/diagnostics";
import TipUserRepo from "./user";
import Paths from "./pay-paths";
import {MangoPayUser} from "./mangopay-user";
import {MangopayAPI, MangopayOptions} from "./mangopay-api";
import {UserStore as ProfileStore} from "@src/users/user";
import * as schemas from "./schemas";
import Store, {Org} from "./store";
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
    tips: new Set([5, 10, 15]),
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

                // const profiles = createProfileStore()
                // profiles.batchFetch([recipient?.pk])

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
                        id: "f6ae4220-1071-702d-f6ba-8c99280cb67b",
                        image: {
                            id: "images/users/0fb5578a-8062-4ca8-8403-b548286f2ced.png",
                            version: 1
                        },
                        first_name: "A Waiter",
                        last_name: "A Waiter",
                        goal: {
                            description: "To buy a car",
                            target: 5000,
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
                        card: body.payment_method
                    }
                }, "")
                return {
                    statusCode: 501
                }
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
