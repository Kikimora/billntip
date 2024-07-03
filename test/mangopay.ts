import mangopay from "mangopay2-nodejs-sdk";

const {Wallets, Users} = require("mangopay2-nodejs-sdk/lib/services")

export const NaturalUser: mangopay.user.CreateUserNaturalOwnerData = {
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
}

export const createUser = jest.spyOn(Users.prototype, 'create').mockImplementation(async (user: any) => {
    return {
        Id: `usr_${user.Email}`,
        ...user
    }
})

export const updateUser = jest.spyOn(Users.prototype, 'update').mockImplementation(async (wallet: any) => {
    return wallet
})

export const createWallet = jest.spyOn(Wallets.prototype, 'create').mockImplementation(async (wallet: any) => {
    return {
        Id: `wlt_${wallet.Owners[0]}_${wallet.Currency}`,
        CreationDate: 1720045732,
        ...wallet
    }
})

export const updateWallet = jest.spyOn(Wallets.prototype, 'update').mockImplementation(async (wallet: any) => {
    return wallet
})

export const getTransactions = jest.spyOn(Wallets.prototype, 'getTransactions')
export const getWallet = jest.spyOn(Wallets.prototype, 'get')

export const Api = new mangopay({
    clientId: 'urbankitchen',
    clientApiKey: "kUazwBMVhOL2tsjUamdO5sBkPSBXbiC1J2uhSPFSNyA0jpRZQX",
    baseUrl: 'https://api.sandbox.mangopay.com'
});
