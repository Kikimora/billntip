import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {makeTestHandler, TestHandler, cognito, mangopay} from "@app/test";
import UserRepo, {User} from "@src/users/user";
import {Org} from "./store";
import {__init, handler} from "./tip"
import {MemberRepo} from "./member";

let group: cognito.TestGroup
let businessLogin: cognito.TestUser
let waiterLogin: cognito.TestUser
let org: Org
let membersRepo: MemberRepo
let usersRepo: UserRepo
let businessUser: User
let waiterUser: User
let registration: TestHandler
let transactions: TestHandler
const adminAddUserToGroup = jest.spyOn(CognitoIdentityProvider.prototype, 'adminAddUserToGroup')

beforeAll(async () => {
    [{usersRepo, membersRepo}, group] = await Promise.all([
        __init(),
        cognito.TestGroup.fetch()
    ]);
    [businessLogin, waiterLogin, org] = await Promise.all([
        group.createUniqueUser(),
        group.createUniqueUser(),
        membersRepo.createOrg({title: "Test"})
    ]);
    ([businessUser, waiterUser] = await Promise.all([
        usersRepo.create(businessLogin.username, "trusted", [
            {name: "first_name", value: "Business"},
            {name: "last_name", value: "User"}
        ]),
        usersRepo.create(waiterLogin.username, "trusted", [
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
    ]))
    registration = makeTestHandler(handler, {
        method: "POST",
        routeKey: "POST /tip/registration",
        authorizer: {lambda: cognito.newSession(waiterLogin.username)}
    })
    transactions = makeTestHandler(handler, {
        method: "GET",
        routeKey: "GET /tip/wallet/transactions",
        authorizer: {lambda: cognito.newSession(waiterLogin.username)}
    });
})

async function cleanupAfterRegistration() {
    try {
        const member = await membersRepo.fetch(waiterLogin.username)
        await Promise.all([
            member.removeMembership(org.pk),
            member.delete()
        ])
    } catch (e: any) {
        if (e.statusCode !== '404') throw e
    }
}

afterAll(async () => {
    await Promise.all([
        waiterLogin?.delete(),
        businessLogin?.delete(),
        businessUser?.delete(true),
        waiterUser?.delete(true),
        org !== undefined ? membersRepo.deleteOrg(org.pk) : Promise.resolve()
    ])
})


describe("POST /tip/registration", () => {

    describe("with valid user", () => {

        afterAll(cleanupAfterRegistration)

        describe("first registration", () => {
            let now: number = 0
            let pendingInvites: any

            beforeAll(async () => {
                now = Date.now() / 1000
                await membersRepo.invite({
                    org: {
                        id: org.pk.replace('O#', ''),
                        title: org.title ?? ""
                    },
                    username: waiterLogin.username,
                    invited_by: {
                        username: businessLogin.username,
                        email: businessLogin.username,
                        first_name: "Business",
                        last_name: "User",
                    },
                    role: 'member'
                })
                pendingInvites = await registration({})
            })

            it("creates MangoPay user", async () => {
                expect(mangopay.createUser).toBeCalledWith({
                    PersonType: "NATURAL",
                    FirstName: "Waiter",
                    LastName: "User",
                    Email: waiterLogin.username,
                    Birthday: Date.parse("1985-05-04"),
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
                    Tag: "Recipient",
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
                const member = await membersRepo.fetch(waiterLogin.username)
                expect(await member.fetch()).toEqual(expect.objectContaining({
                    pk: `U#${waiterLogin.username}`,
                    sk: "M",
                    mangopayUid: expect.toStartWith("usr_"),
                    walletId: expect.toStartWith("wlt_")
                }))
                const membership = await member.fetchMembership(org.pk.replace('O#', ''))
                expect(membership).toEqual(expect.objectContaining({
                    pk: `U#${waiterLogin.username}`,
                    sk: org.pk,
                    org: {
                        id: org.pk.replace('O#', ''),
                        title: "Test"
                    },
                    role: "member",
                    invited_by: {
                        username: businessLogin.username,
                        first_name: "Business",
                        last_name: "User",
                        email: businessLogin.username,
                    },
                    invited_at: expect.closeTo(now, -3)
                }))
            })

            it("adds user to 'recipients' group", async () => {
                expect(adminAddUserToGroup).toHaveBeenCalledWith(expect.objectContaining({
                    GroupName: 'recipient',
                    Username: waiterLogin.username,
                    UserPoolId: expect.toBeString()
                }))
            })

            it("returns pending invites", async () => {
                expect(pendingInvites).toEqual({
                    invites: [{
                        invited_at: expect.closeTo(now, -3),
                        accepted_at: undefined,
                        rejected_at: undefined,
                        invited_by: {
                            email: businessLogin.username,
                            username: businessLogin.username,
                            first_name: "Business",
                            last_name: "User",
                        },
                        org: {
                            id: org.pk.replace('O#', ''),
                            title: "Test"
                        },
                        role: 'member'
                    }]
                })
            })
        })

        describe("subsequent registrations", () => {

            beforeEach(async () => {
                await registration({})
            })

            describe("with changed user", () => {

                beforeEach(async () => {
                    await waiterUser.updateAttributes("trusted", [{
                        name: "first_name", value: "Bibabaka"
                    }])
                })

                it("updates MangoPay user", async () => {
                    await registration({})
                    //assert
                    expect(mangopay.updateUser).toBeCalledWith(expect.objectContaining({
                        FirstName: "Bibabaka",
                    }))
                })

                afterEach(async () => {
                    await waiterUser.updateAttributes("trusted", [{
                        name: "first_name", value: "Waiter"
                    }])
                })
            })

            it("creates only one EUR wallet", async () => {
                await registration({})
                expect(mangopay.createWallet).toHaveBeenCalledOnce()
            })
        })
    })
})

describe("GET /tip/wallet/transactions", () => {
    beforeAll(async () => {
        await registration({})
    })

    afterAll(cleanupAfterRegistration)

    it("return user's wallet transactions", async () => {
        mangopay.getTransactions.mockReturnValueOnce([
            {
                "Id": "xfer_m_01HYX2AZM381923J2DNG5YV50B",
                "Tag": `{ "from": "${businessUser.username}", "to": "${waiterUser.username}" }`,
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
        ])
        mangopay.getWallet.mockReturnValueOnce({
            Description: "Bill&Tip recipient wallet.",
            CreationDate: 1720045732,
            Id: `wlt_mangopay_id`,
            Balance: {Amount: 10, Currency: "EUR"}
        })
        const walletTransactions = await transactions({})
        expect(walletTransactions).toEqual({
            transactions: [{
                id: "xfer_m_01HYX2AZM381923J2DNG5YV50B",
                credit: {amount: 99, currency: "EUR"},
                debit: {amount: 100, currency: "EUR"},
                from: {
                    email: businessUser.username,
                    first_name: "Business",
                    last_name: "User",
                },
                to: {
                    email: waiterUser.username,
                    first_name: "Waiter",
                    last_name: "User",
                },
                type: "TRANSFER",
                execution_date: 1720045246,
                created_at: 1720045246,
                fee: {amount: 1, currency: "EUR"},
                result_code: "000000",
                result_message: "Transaction successful",
                status: "SUCCEEDED"
            }],
            wallet: {
                description: "Bill&Tip recipient wallet.",
                created_at: 1720045732,
                id: waiterUser.username,
                balance: {amount: 10, currency: "EUR"}
            }
        })
    })
})