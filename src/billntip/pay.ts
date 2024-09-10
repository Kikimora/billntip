import {Static, Type} from "@sinclair/typebox";
import {bootstrap, pipeline} from "@app/lambda";
import diagnostics from "@app/diagnostics";
import TipUserRepo from "./user";
import Paths from "./pay-paths";
import {MangoPayUser} from "./mangopay-user";
import {MangopayAPI, MangopayOptions} from "./mangopay-api";
import UserRepo from "@src/users/user";

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
                return {
                    currency: "EUR",
                    feedback: {
                        comment: true,
                        questions: ["1", "2", "3"]
                    },
                    location: "0fb5578a-8062-4ca8-8403-b548286f2ced",
                    organization: "abc",
                    payment_methods: [],
                    recipients: [{
                        type: "person",
                        id: "f6ae4220-1071-702d-f6ba-8c99280cb67b",
                        image: {
                            id: "",
                            version: 1
                        },
                        first_name: "A Waiter",
                        last_name: "A Waiter",
                        goal: "To buy a car"
                    }],
                    tips: [5, 10, 15]
                } satisfies Static<typeof req.route.success>
            }
            case "POST /pay/tip": {
                const {body} = req.parse()
                const user = new MangoPayUser(api, {mangopayUid: body.payer})
                const users = createRecipientsRepo()
                const recipient = await users.fetch(body.recipient.id)
                const walletId = recipient.data.walletId
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
            const users = new UserRepo({
                table: dynamodb.users,
                locks: dynamodb.locks
            })
            return new TipUserRepo({table: dynamodb.data}, mangopay, users)
        }
    })
