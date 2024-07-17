import mangopay, {base} from 'mangopay2-nodejs-sdk'
import {parse as uuidParse, v4} from 'uuid'
import crypto from 'crypto'
import {Api} from "@app/test/mangopay";
import MethodOverload = base.MethodOverload;
import shortUUID from "short-uuid";


it("shorten random bytes", ()=>{
    const shortUUIDGenerator = shortUUID(shortUUID.constants.flickrBase58, { consistentLength: false })
    const d = Date.now().toString(16)
    console.log(d, shortUUIDGenerator.fromUUID(d))
})

describe("MangoPay", () => {

    it("fetches bank account details", async () => {
        const ba = await Api.Users.getBankAccount("user_m_01J26RMVZ59X148AD0WESHFACE", "bankacc_m_01J2KX3639XGHX1H47P82ECEPZ")
        console.log(JSON.stringify(ba))
        console.log(ba)
    })

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

    const wid = "wlt_m_01HYX1ZERF8SC8D8SGZSHANCA7"
    it("Get Wallet Details", async () => {
        const response = await Api.Wallets.get(wid)
        console.log(response)
    })

    it("Debit Wallet", async () => {
        const x: mangopay.transfer.CreateTransfer = {
            AuthorId: uid,
            DebitedWalletId: wid,
            CreditedWalletId: wid,
            Fees: {
                Amount: 1,
                Currency: "EUR"
            },
            DebitedFunds: {
                Amount: 100,
                Currency: "EUR"
            }
        }
        const response = await Api.Transfers.create(x)
        console.log(response)
    })

    it("Get Wallet Transactions", async () => {
        const response = await Api.Wallets.getTransactions(wid)
        console.log(JSON.stringify(response, null, 2))
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
        console.log(response)
    })


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
