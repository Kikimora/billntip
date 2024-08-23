import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {makeTestHandler, cognito, mangopay, prepare, merge, makeFixture} from "@app/test";
import {__init, handler} from "./tip"

const init = prepare('Once', async function () {
    const [module, group] = await Promise.all([__init(), cognito.TestGroup.fetch()])
    return {tipUsers: module.tipUsers, users: module.users, group}
})

const logins = prepare('Once', {
    async before() {
        const {group} = init()
        const [businessLogin, waiterLogin] = await Promise.all([
            group.createUniqueUser(),
            group.createUniqueUser(),
        ])
        return {businessLogin, waiterLogin}
    },
    async after({businessLogin, waiterLogin}) {
        await Promise.all([
            waiterLogin?.delete(),
            businessLogin?.delete()
        ])
    }
})

const data = prepare('Once', {
    async before() {
        const adminAddUserToGroup = jest.spyOn(CognitoIdentityProvider.prototype, 'adminAddUserToGroup')
        const {businessLogin, waiterLogin} = logins()
        const {users, tipUsers} = init()
        const [org, admin, waiter] = await Promise.all([
            tipUsers.createOrg({title: "Test"}),
            users.create(businessLogin.username, "trusted", [
                {name: "first_name", value: "Business"},
                {name: "last_name", value: "User"}
            ]),
            users.create(waiterLogin.username, "trusted", [
                {name: "first_name", value: "Waiter"},
                {name: "last_name", value: "User"},
                {name: "phone", value: "+351111222333"},
                {name: "birthdate", value: "1985-05-04"},
                {
                    name: "address", value: JSON.stringify({
                        street_address: "Rua dos Bill&Tip, 100, 2drt",
                        locality: "Cascais",
                        region: "Lisbon",
                        postal_code: "2750-609",
                        country: "PT"
                    })
                },
                {name: "nationality", value: "RU"},
                {
                    name: "tos", value: JSON.stringify({
                        general: true,
                        privacy: true,
                    })
                },
            ]),
        ])
        return {org, admin, waiter, adminAddUserToGroup}
    },
    async after({org, admin, waiter}) {
        const {tipUsers} = init()
        await Promise.all([
            admin.delete(true),
            waiter.delete(true),
            tipUsers.deleteOrg(org.pk),
        ])
    }
})

const registerWaiter = makeTestHandler(handler, function () {
    const {waiterLogin} = logins()
    return {
        method: "POST",
        routeKey: "POST /tip/registration",
        authorizer: {lambda: cognito.newSession(waiterLogin.username)}
    }
})

const inviteAndRegister = makeFixture({
    async before() {
        const {tipUsers} = init()
        const {org, waiter, admin} = data()

        const now = Date.now() / 1000
        const inviteFromAdmin = await tipUsers.invite({
            org: {
                id: org.pk,
                title: org.title ?? ""
            },
            username: waiter.username,
            invited_by: admin.username,
            role: 'member'
        })

        const pendingInvites = await registerWaiter({})

        return {now, pendingInvites, inviteFromAdmin}
    },
    async after() {
        jest.clearAllMocks()
        const {tipUsers} = init()
        const {org, waiter} = data()
        const member = await tipUsers.fetch(waiter.username)
        await Promise.all([
            member.removeMembership(org.pk),
            member.delete()
        ])
    }
});

describe("POST /tip/registration", () => {

    describe("with valid user", () => {

        describe("first registration", () => {
            const fixture = merge(data, prepare('Once', inviteAndRegister))

            it("creates MangoPay user", async () => {
                const {waiter} = fixture()
                expect(mangopay.createUser).toBeCalledWith({
                    PersonType: "NATURAL",
                    FirstName: "Waiter",
                    LastName: "User",
                    Email: waiter.username,
                    Birthday: Date.parse("1985-05-04") / 1000,
                    Nationality: "RU",
                    CountryOfResidence: "PT",
                    TermsAndConditionsAccepted: true,
                    Address: {
                        AddressLine1: "Rua dos Bill&Tip, 100, 2drt",
                        AddressLine2: "",
                        City: "Cascais",
                        Region: "Lisbon",
                        PostalCode: "2750-609",
                        Country: "PT"
                    },
                    Tag: waiter.username,
                    UserCategory: "OWNER",
                })
            })

            it("creates EUR wallet", async () => {
                expect(mangopay.createWallet).toBeCalledWith({
                    Currency: "EUR",
                    Description: "Bill&Tip recipient wallet.",
                    Owners: [expect.toBeString()],
                    Tag: "Recipient"
                })
            })

            it("creates member record", async () => {
                const {tipUsers} = init()
                const {now, org, waiter, admin} = fixture()

                const member = await tipUsers.fetch(waiter.username)
                const userItem = await member.fetch();
                expect(userItem).toMatchObject({
                    pk: waiter.username,
                    mangopayUid: expect.toStartWith("usr_"),
                    walletId: expect.toStartWith("wlt_")
                })
                const membership = await member.fetchMembership(org.pk)
                expect(membership).toMatchObject({
                    id: waiter.username,
                    org: {
                        id: org.pk,
                        title: "Test"
                    },
                    role: "member",
                    invited_by: {
                        id: admin.username,
                        first_name: "Business",
                        last_name: "User",
                        email: admin.username,
                    },
                    invited_at: expect.closeTo(now, -3),
                    user: {
                        id: waiter.username,
                        email: waiter.username,
                        first_name: "Waiter",
                        last_name: "User"
                    },
                })
            })

            it("adds user to 'recipients' group", async () => {
                const {adminAddUserToGroup, waiter} = fixture()
                expect(adminAddUserToGroup).toHaveBeenCalledWith(expect.objectContaining({
                    GroupName: 'recipient',
                    Username: waiter.username,
                    UserPoolId: expect.toBeString()
                }))
            })

            it("returns pending invites", async () => {
                const {now, pendingInvites, org, admin, waiter} = fixture()

                expect(pendingInvites).toEqual({
                    invites: [{
                        id: waiter.username,
                        user: {
                            id: waiter.username,
                            email: waiter.username,
                            first_name: "Waiter",
                            "last_name": "User",
                            profile_pic: undefined
                        },
                        invited_at: expect.closeTo(now, -3),
                        accepted_at: undefined,
                        rejected_at: undefined,
                        invited_by: {
                            email: admin.username,
                            id: admin.username,
                            first_name: "Business",
                            last_name: "User",
                            profile_pic: undefined,
                        },
                        org: {
                            id: org.pk,
                            title: "Test"
                        },
                        role: 'member'
                    }]
                })
            })
        })

        describe("subsequent registrations", () => {

            const fixture = merge(data, prepare('Each', inviteAndRegister))

            describe("with changed user", () => {

                beforeEach(async () => {
                    const {waiter} = fixture()
                    await waiter.updateAttributes("trusted", [{
                        name: "first_name", value: "Bibabaka"
                    }])
                })

                it("updates MangoPay user", async () => {
                    await registerWaiter({})
                    //assert
                    expect(mangopay.updateUser).toBeCalledWith(expect.objectContaining({
                        FirstName: "Bibabaka",
                    }))
                })

                afterEach(async () => {
                    const {waiter} = fixture()
                    await waiter.updateAttributes("trusted", [{
                        name: "first_name", value: "Waiter"
                    }])
                })
            })

            it("creates only one EUR wallet", async () => {
                await registerWaiter({})
                expect(mangopay.createWallet).toHaveBeenCalledOnce()
            })
        })
    })
})

const transactions = makeTestHandler(handler, function () {
    const {waiterLogin} = logins()
    return {
        method: "GET",
        routeKey: "GET /tip/transactions",
        authorizer: {
            lambda: cognito.newSession(waiterLogin.username, {
                profile: {
                    "cognito:groups": ["recipient"]
                }
            })
        }
    }
});

describe("GET /tip/transactions", () => {

    prepare('Once', inviteAndRegister)

    it("return user's wallet transactions", async () => {
        const {admin, waiter} = data()
        mangopay.getTransactions.mockReturnValueOnce(Promise.resolve([
            {
                "Id": "xfer_m_01HYX2AZM381923J2DNG5YV50B",
                "Tag": `{ "from": "${admin.username}", "to": "${waiter.username}" }`,
                "AuthorId": "user_m_01HYX1T7R4ZC34YG4EMJYA9AGQ",
                "CreditedUserId": "user_m_01HYX1T7R4ZC34YG4EMJYA9AGQ",
                "DebitedFunds": {
                    "Currency": "EUR",
                    "Amount": 100
                },
                "CreditedFunds": {
                    "Currency": "EUR",
                    "Amount": 99
                },
                "Fees": {
                    "Currency": "EUR",
                    "Amount": 1
                },
                "Status": "SUCCEEDED",
                "ResultCode": "000000",
                "ResultMessage": "Transaction successful",
                "ExecutionDate": 1720045246,
                "CreationDate": 1720045246,
                "Type": "TRANSFER",
                "Nature": "REGULAR",
                "CreditedWalletId": "wlt_m_01HYX1ZERF8SC8D8SGZSHANCA7",
                "DebitedWalletId": "wlt_m_01HYX1ZERF8SC8D8SGZSHANCA7",
                "DepositId": null
            }
        ]))
        mangopay.getWallet.mockReturnValueOnce(Promise.resolve({
            Description: "Bill&Tip recipient wallet.",
            CreationDate: 1720045732,
            Id: `wlt_mangopay_id`,
            Balance: {Amount: 10, Currency: "EUR"}
        }))
        const walletTransactions = await transactions({})
        expect(walletTransactions).toEqual({
            transactions: [{
                id: "xfer_m_01HYX2AZM381923J2DNG5YV50B",
                credit: {amount: 99, currency: "EUR"},
                debit: {amount: 100, currency: "EUR"},
                from: admin.username,
                to: waiter.username,
                type: "TRANSFER",
                execution_date: 1720045246,
                created_at: 1720045246,
                fee: {amount: 1, currency: "EUR"},
                result_code: "000000",
                result_message: "Transaction successful",
                status: "SUCCEEDED"
            }],
            page: 1,
            per_page: 10,
            wallet: {
                amount: 10, currency: "EUR"
            }
        })
    })
})