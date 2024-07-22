import mangopay, {base} from 'mangopay2-nodejs-sdk'
import {Api} from "@app/test/mangopay";
import MethodOverload = base.MethodOverload;
import shortUUID from "short-uuid";


it("shorten random bytes", () => {
    const shortUUIDGenerator = shortUUID(shortUUID.constants.flickrBase58, {consistentLength: false})
    const d = Date.now().toString(16)
    console.log(d, shortUUIDGenerator.fromUUID(d))
})

describe("MangoPay", () => {

    describe("fetching information", () => {
        it("bank account details", async () => {
            try {
                const ba = await Api.Users.getBankAccount("user_m_01J26RMVZ59X148AD0WESHFACE", "bankacc_m_01J2KX3639XGHX1H47P82ECEPZ")
                console.log("Api.Users.getBankAccount: ", JSON.stringify(ba, null, 2))
            } catch (e) {
                console.log(JSON.stringify(e, null, 2))
            }
        })

        const wid = "wlt_m_01J26RMW2N8TZ17JBGP7CEKFMH"
        it("Get Wallet Details", async () => {
            const response = await Api.Wallets.get(wid)
            console.log("Api.Wallets.get: ", JSON.stringify(response, null, 2))
        })

        it("Get Wallet Transactions", async () => {
            const response = await Api.Wallets.getTransactions(wid)
            console.log("Api.Wallets.getTransactions: ", JSON.stringify(response, null, 2))
        })

        it("Get Wallet Transactions with pagination and filters", async () => {
            const parameters = {
                // Options for pagination
                per_page: 1,
                page: 1,
                // Options for Filters
                //BeforeDate: 1683129820,
                //AfterDate: 1682957020,
                // Status: FAILED,
                // Type: TRANSFER,
            };
            const response = await Api.Wallets.getTransactions(wid, {parameters})
            console.log("Api.Wallets.getTransactions with parameters: ", parameters)
            console.log(JSON.stringify(response, null, 2))
        })

        it("Get individual transaction", async () => {
            const response = await Api.PayOuts.get("po_m_01J31CGYNP3NBXGVQJF7DBA7QT")
            console.log("Api.Transfers.get: ", JSON.stringify(response, null, 2))
        })

        it("Get 404 error", async () => {
            try {
                await Api.PayOuts.get("po_m_01J31CGYNP3NBXGVQJF7DBA7TQ")
            } catch (e) {
                console.log("Api.Transfers.get: ", JSON.stringify(e, null, 2))
            }
        })

    })

    describe("PayIn PayOut story", () => {
        it("creates test bank account", async () => {
            try {
                const account = await Api.Users.createBankAccount("user_m_01J26RMVZ59X148AD0WESHFACE", {
                    Type: "IBAN",
                    IBAN: "FR7630004000031234567890143",
                    BIC: "BNPAFRPP",
                    OwnerName: "Andrei Verbin",
                    OwnerAddress: {
                        AddressLine1: "Rua dos Alamos, 209",
                        PostalCode: "2750-609",
                        City: "Cascais",
                        Country: "PT"
                    }
                } as any)
                console.log(JSON.stringify(account))
            } catch (e) {
                console.log(e)
            }
        })
        it("creates BankWire PayIn", async () => {
            try {
                const response = await Api.PayIns.create({
                    ExecutionType: "DIRECT",
                    PaymentType: "BANK_WIRE",
                    AuthorId: "user_m_01J26RMVZ59X148AD0WESHFACE",
                    CreditedWalletId: "wlt_m_01J26RMW2N8TZ17JBGP7CEKFMH",
                    CreditedUserId: "user_m_01J26RMVZ59X148AD0WESHFACE",
                    DeclaredDebitedFunds: {
                        Currency: "EUR",
                        Amount: 100
                    },
                    DeclaredFees: {
                        Currency: "EUR",
                        Amount: 1
                    },
                    Tag: "Test"
                })
                console.log("Success", JSON.stringify(response))
            } catch (e) {
                console.log("Error", JSON.stringify(e))
            }
        })
        it("creates CC registration", async () => {
            try {
                const registration = await Api.CardRegistrations.create({
                    UserId: "user_m_01J26RMVZ59X148AD0WESHFACE",
                    Currency: "EUR",
                    CardType: "CB_VISA_MASTERCARD",
                    Tag: "Test"
                })
                console.log("Success", JSON.stringify(registration))
            } catch (e) {
                console.log("Error", JSON.stringify(e))
            }
        })
        it("tokenize CC ", async () => {

            async function registerCard() {
                return await Api.CardRegistrations.create({
                    UserId: "user_m_01J26RMVZ59X148AD0WESHFACE",
                    Currency: "EUR",
                    CardType: "CB_VISA_MASTERCARD",
                    Tag: "Test"
                })
            }

            async function tokenizeCard(tokenizationResponse: any) {
                const response = await fetch(tokenizationResponse.CardRegistrationURL, {
                    method: "POST",
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: new URLSearchParams({
                        'accessKeyRef': tokenizationResponse.AccessKey,
                        'data': tokenizationResponse.PreregistrationData,
                        'cardNumber': '4970107111111119',
                        'cardExpirationDate': '1235',
                        'cardCvx': '123',
                    })
                })
                const bodyText = await response.text()
                if (response.status >= 300) {
                    throw bodyText
                }
                return bodyText
            }

            async function updateCardRegistration(registrationId: string, registrationData: string) {
                return await Api.CardRegistrations.update({
                    Id: registrationId,
                    RegistrationData: registrationData,
                    CardHolderName: "Andrei Verbin"
                })
            }

            try {
                const registrationResponse = await registerCard()
                console.log("Register", JSON.stringify(registrationResponse, null, 2))
                const tokenizationResponse = await tokenizeCard(registrationResponse)
                console.log("Tokenization", tokenizationResponse)
                const updatedRegistration = await updateCardRegistration(registrationResponse.Id, tokenizationResponse)
                console.log("Update", JSON.stringify(updatedRegistration, null, 2))
            } catch (e) {
                console.log("Error", JSON.stringify(e))
            }
        })
        it("creates CC PayIn", async () => {
            try {
                const response = await Api.PayIns.create({
                    ExecutionType: "DIRECT",
                    PaymentType: "CARD",
                    AuthorId: "user_m_01J26RMVZ59X148AD0WESHFACE",
                    CreditedUserId: "user_m_01J26RMVZ59X148AD0WESHFACE",
                    CreditedWalletId: "wlt_m_01J26RMW2N8TZ17JBGP7CEKFMH",
                    DebitedFunds: {
                        Currency: "EUR",
                        Amount: 100
                    },
                    Fees: {
                        Currency: "EUR",
                        Amount: 1
                    },
                    SecureModeReturnURL: "https://localhost",
                    CardId: "card_m_01J30BP0Y3WNA31G6CJZB6D09G",
                    IpAddress: "127.0.0.1",
                    BrowserInfo: {
                        Language: "PT",
                        AcceptHeader: "application/json",
                        ColorDepth: 32,
                        JavaEnabled: false,
                        JavascriptEnabled: true,
                        ScreenHeight: 768,
                        ScreenWidth: 1024,
                        TimeZoneOffset: 0,
                        UserAgent: "test/browser"
                    },
                    SecureMode: "DEFAULT",
                    Tag: "Test"
                } as any)
                console.log("Success", JSON.stringify(response, null, 2))
            } catch (e) {
                console.log("Error", JSON.stringify(e, null, 2))
            }
        }, 15000)
        it("creates BankWire PayOut", async () => {
            try {
                const response = await Api.PayOuts.create({
                    PaymentType: "BANK_WIRE",
                    AuthorId: "user_m_01J26RMVZ59X148AD0WESHFACE",
                    DebitedFunds: {
                        Currency: "EUR",
                        Amount: 100
                    },
                    Fees: {
                        Currency: "EUR",
                        Amount: 1
                    },
                    BankAccountId: "bankacc_m_01J2KX3639XGHX1H47P82ECEPZ",
                    DebitedWalletId: "wlt_m_01J26RMW2N8TZ17JBGP7CEKFMH",
                    BankWireRef: "Bill&Tip",
                    PayoutModeRequested: "STANDARD",
                    Tag: "Test"
                })
                console.log("Success", JSON.stringify(response, null, 2))
            } catch (e) {
                console.log("Error", JSON.stringify(e))
            }
        })
    })

    describe.skip("create user and wallet", () => {
        it("Create user", async () => {
            //createUser.mockRestore()

            const response = await Api.Users.create({
                PersonType: "NATURAL",
                FirstName: "string",
                LastName: "string",
                Email: "example@example.com",
                Birthday: 1,
                Nationality: "PT",
                CountryOfResidence: "PT",
                TermsAndConditionsAccepted: true,
                Address: {
                    AddressLine1: "1",
                    AddressLine2: "string",
                    City: "sss",
                    Region: "aaa",
                    PostalCode: "2750-609",
                    Country: "PT"
                },
                Tag: "Test",
                Occupation: "string",
                IncomeRange: 3,
                UserCategory: "OWNER",
            })
            console.log(response)
        })

        const uid = "user_m_01HYX1T7R4ZC34YG4EMJYA9AGQ"
        it("Create wallet", async () => {
            const x: mangopay.wallet.CreateWallet = {
                Currency: "EUR",
                Description: "Test wallet",
                Owners: [uid],
                Tag: "test"
            }
            const response = await Api.Wallets.create(x)
            console.log(response)
        })
    })

    describe.skip('transfers between wallet', () => {
        it("transfers from wallet to wallet", async () => {
            try {
                const response = await Api.Transfers.create({
                    AuthorId: "user_m_01J26RMVZ59X148AD0WESHFACE",
                    DebitedWalletId: "wlt_m_01J26RMW2N8TZ17JBGP7CEKFMH",
                    DebitedFunds: {
                        Amount: 100,
                        Currency: "EUR"
                    },
                    CreditedUserId: "user_m_01J2M11ADZZFYVM3R31PDWT7PP",
                    CreditedWalletId: "wlt_m_01J2M11AJVKMGXKC1GH7MGXR9X",
                    Fees: {
                        Amount: 1,
                        Currency: "EUR"
                    }
                })
                console.log(JSON.stringify(response, null, 2))
            } catch (e) {
                console.log(JSON.stringify(e, null, 2))
            }
        })
    });
})

interface RegulatoryData {
    Id: string
    ActionCode: string
    ScopeBlocked: {
        Inflows: boolean
        Outflows: boolean
    }
}

interface RegulatoryDataProvider {
    getRegulatory: MethodOverload<string, RegulatoryData>;
}

it("fetches regulatory status", async () => {
    const Users = await Api.Users as unknown as RegulatoryDataProvider
    const r = await Users.getRegulatory("user_m_01HYX1T7R4ZC34YG4EMJYA9AGQ")
    console.log(JSON.stringify(r, null, 2))
})
