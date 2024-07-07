import mangopay, {base} from 'mangopay2-nodejs-sdk'
import {randomBytes} from '@noble/ciphers/webcrypto';
import {parse as uuidParse, v4} from 'uuid'
import crypto from 'crypto'
import {Api} from "@app/test/mangopay";
import MethodOverload = base.MethodOverload;

const shorter = require('shorter');

describe("MangoPay", () => {
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

    //1.

    it('aaa', ()=>{
        const uid = Buffer.from(uuidParse(v4()))
        const key = randomBytes(16)
        const hmac = crypto.createHmac('md5', key)
            .update(uid)
            .digest()
        console.log(uid.length, hmac.length)

        const c = shorter.compress(Buffer.concat([uid, hmac])).toString();
        console.log(c, c.length)
        console.log(uid.toString('base64url'), uid.toString('base64url').length)
        console.log(hmac.toString('base64url'), hmac.toString('base64url').length)

        //
        // for (let cipher of [gcm, siv]) {
        //     const stream = cipher(key, randomBytes(12));
        //     const ciphertext_ = stream.encrypt(uid);
        //     const plaintext_ = stream.decrypt(ciphertext_);
        //     const m1 = Buffer.from(ciphertext_).toString('base64url');
        //     const originalUid = uuidStringify(plaintext_);
        //     const originalUidB64 = Buffer.from(plaintext_).toString('base64url');
        //
        //
        //
        //     console.log(m1, m1.length, originalUid, originalUid.length, originalUidB64, originalUidB64.length, hmac, hmac.length, c, c.length)
        // }
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
