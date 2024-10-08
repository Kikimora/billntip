import mangopay from "mangopay2-nodejs-sdk";
import _ from "lodash";
import {toPascalCase} from "@app/util";
import {badRequestError, internalError} from "@app/lambda";
import {errorWithContext} from "@app/diagnostics";
import * as schemas from "./schemas";
import {MangopayAPI} from "./mangopay-api";

export interface MangoPayUserItem {
    mangopayUid: string
    wallet?: string | schemas.Wallet
}

export class MangopayWallet {
    constructor(private readonly api: MangopayAPI,
                private readonly ownerId: string,
                private wallet?: string | schemas.Wallet) {
    }

    get walletId() {
        const {wallet} = this
        if (wallet === undefined || typeof wallet === "string") return wallet
        return wallet.id
    }

    async create(tag: string) {
        const {wallet, ownerId, api} = this
        if (this.wallet !== undefined)
            throw internalError().withContext("create", {wallet, tag, ownerId})
        return this.wallet = await api.createWallet(ownerId, tag)
    }

    async fetch(force: boolean = false): Promise<schemas.Wallet> {
        const {walletId, wallet, ownerId, api} = this
        if (wallet === undefined || walletId === undefined)
            throw internalError().withContext("fetch", {ownerId})
        if (typeof wallet !== "string" && !force) return wallet

        const [response, pendingPayouts] = await Promise.all([
            api.fetchWallet(walletId),
            api.getTransactions(walletId, {
                parameters: {
                    Status: "CREATED",
                    Type: "PAYOUT"
                }
            })
        ]).catch(function (e) {
            throw errorWithContext(e, "fetchWallet", {ownerId, cause: e})
        })

        const pending = pendingPayouts.reduce(function (acc, p) {
            return acc + p.debit.amount
        }, 0)
        return this.wallet = {
            id: response.Id,
            created_at: response.CreationDate,
            description: response.Description,
            amount: response.Balance.Amount,
            currency: response.Balance.Currency,
            pending: pending
        }
    }

    async transactions(query: schemas.TransactionsQuery) {
        const {walletId, ownerId, api} = this
        if (walletId === undefined) throw internalError().withContext("fetch", {ownerId})
        const request = {parameters: toQuery(query),};
        return await api.getTransactions(walletId, request)
    }

    async fetchTransaction(id: string) {
        const {walletId, ownerId, api} = this
        if (walletId === undefined) throw internalError().withContext("fetch", {ownerId})
        return await api.fetchTransaction(id, ownerId).catch(function (e) {
            throw errorWithContext(e, "fetchTransaction", {walletId})
        })
    }

    async createTransaction(request: schemas.CreateTransactionRequest, tag: string): Promise<schemas.Transaction> {
        const {api, ownerId, walletId} = this
        if (walletId === undefined) throw internalError().withContext("createTransaction", {ownerId})
        return await api.createTransaction(ownerId, walletId, request, tag)
    }
}

export class MangoPayUser {
    public readonly defaultWallet: MangopayWallet

    constructor(public readonly api: MangopayAPI,
                private readonly member: MangoPayUserItem) {
        this.defaultWallet = new MangopayWallet(this.api, member.mangopayUid, member.wallet)
    }

    get uid() {
        return this.member.mangopayUid
    }

    async createEmptyCard(request: schemas.NewEmptyCardRequest, tag?: string): Promise<schemas.CardRegistration> {
        const {member, api} = this
        const card = await api.createEmptyCard({
            UserId: this.member.mangopayUid,
            Currency: request.currency as any,
            CardType: request.type,
            Tag: tag
        }).catch(function (e) {
            throw errorWithContext(e, "createEmptyCard", {member, tag})
        })
        if (card.Status !== 'CREATED') {
            throw internalError("Unexpected error creating card").withContext("createEmptyCard", {
                request,
                member,
                tag,
                card
            })
        }
        return {
            id: card.Id,
            type: card.CardType,
            currency: card.Currency,
            tokenization: {
                access_key: card.AccessKey,
                data: card.PreregistrationData,
                id: card.CardRegistrationURL
            }
        }
    }

    async updateCard(request: schemas.UpdateCardRequest): Promise<schemas.Card> {
        const {member, api} = this
        const registration = await api.updateCard({
            Id: request.id,
            RegistrationData: request.token,
            CardHolderName: request.cardholder_name
        }).catch(function (e) {
            throw errorWithContext(e, "updateCard", {member})
        })
        if (registration.Status !== 'VALIDATED') {
            throw internalError("Unexpected error creating card").withContext("updateCard", {
                request,
                member,
                card: registration
            })
        }
        const card = await api.fetchCard(registration.CardId).catch(function (e) {
            throw errorWithContext(e, "fetchCard", {member, registration})
        })
        return {
            id: card.Id,
            alias: card.Alias,
            provider: card.CardProvider,
            bank_code: card.BankCode,
            country: card.Country,
            fingerprint: card.Fingerprint,
            exp: card.ExpirationDate,
            createdAt: card.CreationDate,
            currency: registration.Currency,
            type: registration.CardType
        }
    }

    async fetchUserInfo() {
        const {member, api} = this
        const response = await api.fetchUser(member.mangopayUid) as mangopay.models.UserNatural
        return {
            id: response.Id,
            created_at: response.CreationDate,
            kycLevel: response.KYCLevel,
            category: response.UserCategory,
            proofOfIdentity: response.ProofOfIdentity !== null ? response.ProofOfIdentity : undefined,
            proofOfAddress: response.ProofOfAddress !== null ? response.ProofOfAddress : undefined,
        }
    }

    async fetchRegulatoryStatus() {
        const {member, api} = this
        const response = await api.fetchRegulatoryStatus(member.mangopayUid)
        return {
            action_code: response.ActionCode,
            blocked: {
                inflows: response.ScopeBlocked.Inflows,
                outflows: response.ScopeBlocked.Outflows,
            }
        }
    }

    async transactions(query: schemas.TransactionsQuery) {
        return this.defaultWallet.transactions(query)
    }

    async fetchTransaction(id: string) {
        return this.defaultWallet.fetchTransaction(id)
    }

    async createTransaction(walletId: string, request: schemas.CreateTransactionRequest, tag: string): Promise<schemas.Transaction> {
        const {api, uid} = this
        return await api.createTransaction(uid, walletId, request, tag)
    }

    async startVerification({files, type}: schemas.VerificationRequest): Promise<schemas.VerificationResponse> {
        const {member, api} = this
        const {mangopayUid} = member
        const details = await this.fetchVerificationDetails()
        if (details[type]?.status === 'VALIDATION_ASKED') {
            throw badRequestError("Verification already in progress")
                .withContext("startVerification", {type, member, details})
        }
        let doc = await api.createKycDocument(mangopayUid, type)
        const uploads = files.map(function (page) {
            return api.createKycPage(mangopayUid, doc.process_id, {File: page})
        })
        await Promise.all(uploads)
        doc = await api.submitKycDocument(mangopayUid, doc.process_id)
        return {type: type, data: doc}
    }

    async fetchVerificationDetails(): Promise<schemas.KYCDetails> {
        const {member, api} = this
        const {mangopayUid} = member
        return await api.kycDocuments(mangopayUid)
    }

    async fetchBankAccounts(query: schemas.BankAccountsQuery): Promise<schemas.BankAccount[]> {
        const {member, api} = this
        const {mangopayUid} = member

        const request = {parameters: toQuery(query),};
        return await api.bankAccounts(mangopayUid, request)
    }

    async fetchBankAccount(bankAccountId: string): Promise<schemas.BankAccount> {
        const {member, api} = this
        const {mangopayUid} = member
        return await api.fetchBankAccount(mangopayUid, bankAccountId)
    }

    async deactivateBankAccount(bankAccountId: string): Promise<schemas.BankAccount> {
        const {member, api} = this
        const {mangopayUid} = member
        return await api.deactivateBankAccount(mangopayUid, bankAccountId)
    }

    async createBankAccount(body: schemas.CreateBankAccountRequest): Promise<schemas.BankAccount> {
        const {member, api} = this
        const {mangopayUid} = member
        return await api.createBankAccount(mangopayUid, body)
    }
}

/**
 * Generic utility to map queries to MangoPay queries.
 */
function toQuery(query: Record<string, string | number | boolean>): (mangopay.base.FilterOptions & mangopay.base.PaginationOptions) {
    return _(query)
        .mapKeys(function (value, key) {
            switch (key) {
                case 'before':
                    return 'BeforeDate'
                case 'after':
                    return 'AfterDate'
                case 'per_page':
                    return 'Per_Page'
                default:
                    return toPascalCase(key)
            }
        })
        .mapValues(function (value, key) {
            switch (key) {
                case 'Sort':
                    if (typeof value === 'string') {
                        let [column, dir] = value.split(':')
                        switch (column) {
                            case 'created_at':
                                column = 'CreationDate';
                                break;
                        }
                        return `${toPascalCase(column)}:${dir}`
                    }
                    return value
                default:
                    return value
            }
        })
        .value()
}

