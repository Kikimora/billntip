import {AppError, internalServerError, LambdaRequest, TracedEvent} from "@app/lambda";
import {DynamoDB, TransactionCanceledException} from "@aws-sdk/client-dynamodb";
import * as ddb from "@app/dynamodb";
import _, {mergeJoin, MergePair} from "@app/util";
import {ErrorContext, errorWithContext} from "@app/diagnostics";
import * as Schemas from "./schemas";
import UserStore, {UserAttributeItem, UserStoreOptions} from "./store";
import {UserAttribute} from "./attributes";

export const LocksTableName = process.env.LOCKS_TABLE ?? _.throw("Missing required LOCKS_TABLE env variable")

export {UserAttribute} from "./attributes"

/**
 * Fetch operation options.
 */
export interface FetchOptions {
    /**
     * Allow fetch with unverified alias, default - false
     */
    allowUnverifiedAlias?: boolean,
    /**
     * Allow fetch of deleted users, default - false
     */
    fetchDeleted?: boolean
}

/**
 * User data repository provides methods to load users from the storage.
 */
export default class UserRepo {
    readonly lockStore: ddb.LockStore;
    private readonly store: UserStore


    constructor(public readonly req: LambdaRequest & TracedEvent,
                public readonly db: DynamoDB,
                options?: UserStoreOptions) {
        this.store = new UserStore(db, options)
        this.lockStore = ddb.makeLockStore(LocksTableName, {dynamoDb: db})
    }

    /**
     * Return true if provide attribute is an alias attribute (e.g. phone_number).
     * @param attribute - attribute or attribute name
     */
    isAliasAttribute(attribute: UserAttribute | string): boolean {
        return this.store.isAliasAttribute(attribute)
    }

    /**
     * Given a username or an alias lookup Cognito username.
     */
    async lookupAlias(usernameOrAlias: string) {
        const {store} = this

        async function lookupAlias(usernameOrAlias: string) {
            try {
                return await store.lookupAlias(usernameOrAlias)
            } catch (e: any) {
                throw internalServerError(e.message).withContext({
                    name: 'lookupAlias',
                    value: {
                        usernameOrAlias
                    }
                })
            }
        }

        const alias = await lookupAlias(usernameOrAlias)
        if (alias?.username === undefined) {
            throw userNotFoundException()
        }
        return {username: alias.username, verified: alias.verified ?? false}
    }

    /**
     * Filter aliases attributes from the attribute list.
     * @param attributes - user attributes
     */
    aliases(attributes: string[]): string[]
    aliases(attributes: UserAttribute[]): UserAttribute[]
    aliases(attributes: UserAttribute[] | string[]) {
        return attributes.filter(x => this.isAliasAttribute(x))
    }

    /**
     * Filter aliases and verifier attributes from the attribute list.
     * @param attributes - user attributes
     */
    normalAttributes(attributes: string[]): string[]
    normalAttributes(attributes: UserAttribute[]): UserAttribute[]
    normalAttributes(attributes: UserAttribute[] | string[]) {
        return attributes.filter(x => !this.isAliasAttribute(x))
    }

    /**
     * Create and lock user, see {@link User.updateAttributes} for more details.
     * @param username - username provided by the user, must be globally unique.
     * @param source - attributes source
     * @param attributes - user attributes
     */
    async createLocked(username: string, source: "trusted" | "user" = 'user', attributes?: UserAttribute[]) {
        return this._create(username, true, source, attributes)
    }

    /**
     * Create user with attributes, see {@link User.updateAttributes} for more details.
     * @param username - username provided by the user, must be globally unique.
     * @param source - attributes source
     * @param attributes - user attributes
     */
    create(username: string, source: "trusted" | "user" = 'user', attributes?: UserAttribute[]) {
        return this._create(username, false, source, attributes)
    }

    private async _create(username: string, lock: boolean, source: "trusted" | "user" = 'user', attributes?: UserAttribute[]) {
        const user = new User(username, this.req, this.store, this.lockStore)
        if (lock)
            await user.lock()
        try {
            await user.create(source, attributes ?? [])
        } catch (e) {
            if (lock)
                await user.unlock()
            throw e
        }
        return user
    }

    /**
     * Fetch and lock user using alias or username.
     * @param usernameOrAlias - username or alias attributes (e.g. email or phone_number)
     * @param options - fetch options
     */
    async fetchLocked(usernameOrAlias: string, options?: FetchOptions) {
        return await this._fetch(usernameOrAlias, true, options)
    }

    /**
     * Fetch user without locking using alias or username.
     * @param usernameOrAlias - username or alias attributes (e.g. email or phone_number)
     * @param options - fetch options
     */
    async fetch(usernameOrAlias: string, options?: FetchOptions) {
        return await this._fetch(usernameOrAlias, false, options)
    }

    private async _fetch(usernameOrAlias: string, lock: boolean, options?: FetchOptions) {
        const self = this
        const {username, verified} = await lookupAlias()

        const context: ErrorContext = {
            name: "fetch",
            value: {
                usernameOrAlias,
                lock,
                options,
                username,
                verified
            }
        };

        if (!verified && !(options?.allowUnverifiedAlias ?? false)) {
            throw userNotFoundException().withContext(context)
        }

        const user = new User(username, this.req, this.store, this.lockStore)

        try {
            if (lock) {
                await user.lock()
            }
            await user.fetch()
        } catch (e: any) {
            if (lock) {
                //ignore unlock errors
                await user.unlock().catch()
            }
            throw errorWithContext(e, context)
        }
        if (user.deleted && !(options?.fetchDeleted ?? false))
            throw userNotFoundException().withContext(context)

        return user


        async function lookupAlias() {
            if (options?.fetchDeleted) {
                return {
                    username: usernameOrAlias,
                    verified: true
                }
            } else {
                return await self.lookupAlias(usernameOrAlias)
            }
        }
    }
}

export class User {
    private _attributes: UserAttributeItem[] = []
    private _deleted: boolean = false

    private _lock?: ddb.LockHandle;

    constructor(public readonly username: string,
                private readonly req: LambdaRequest & TracedEvent,
                private readonly store: UserStore,
                private readonly lockStore: ddb.LockStore,) {
        this._attributes = []

    }

    private get requestId() {
        return this.req.requestContext.requestId
    }

    get attributes(): Readonly<UserAttribute[]> {
        return Array.from(makeAttributes(this._attributes))

        function* makeAttributes(attributes: UserAttributeItem[]): Generator<UserAttribute> {
            for (const attr of attributes) {
                if (attr.isAlias) {
                    if (attr.value !== undefined) {
                        yield {
                            name: attr.name,
                            value: attr.value,
                            verified: true
                        }
                    }
                    if (attr.unverifiedValue !== undefined) {
                        yield {
                            name: attr.name,
                            value: attr.unverifiedValue,
                            verified: false
                        }
                    }
                } else if (attr.value !== undefined) {
                    yield {
                        name: attr.name,
                        value: attr.value
                    }
                }
            }
        }
    }

    get deleted() {
        return this._deleted
    }

    get isLocked() {
        return this._lock?.locked ?? false
    }

    async lock() {
        const {username, lockStore, requestId} = this
        this._lock = await lockStore.tryLock(username, requestId, {
            leaseDuration: 100,
            autoBump: true
        });
    }

    async [Symbol.dispose](): Promise<void> {
        await this.unlock()
    }

    async unlock() {
        await this._lock?.unlock()
    }

    /**
     * Load user data from DynamoDB.
     */
    async fetch() {
        const {username, store} = this

        const context = {
            name: "fetch",
            value: {username}
        }

        async function fetchUserItems(username: string) {
            try {
                return await store.fetch(username)
            } catch (e: any) {
                throw internalServerError(e.message).withContext(context, {cause: e})
            }
        }

        const items = await fetchUserItems(username)
        if (items === undefined) throw userNotFoundException().withContext(context)
        this._attributes = items.attributes
        this._deleted = items.deleted
    }

    /**
     * Create user record, fail if user exists or any of the aliases exists and bookAlias is true.
     *
     * OIDC attributes have priority over user attributes.
     * If user updates a verified alias attribute then user value goes to pending until it is verified.
     * If user updates an unverified alias attribute then alias attribute value changes.
     *
     * @param source - source of data
     * @param attributes - user and oidc attributes, max 50
     */
    async create(source: "user" | "trusted", attributes: UserAttribute[]) {
        const {username} = this
        const context = {
            name: "create",
            value: {
                username,
                attributes,
                source
            }
        }
        try {
            await this._updateAttributes(attributes, source, 'create');
        } catch (e: any) {
            throw errorWithContext(e, context)
        }
    }

    /**
     * Update user attributes.
     *
     * For each alias attribute this method tries to book it, that is create an unconfirmed alias record in the storage.
     * If booking fails then entire update fails. Different alias attributes cannot have same value or be equal to the username.
     *
     * If {@link source} is 'trusted' then method trusts verifier attributes and automatically confirm corresponding aliases.
     * E.g. if provided with both {name:'email',value:'a@example.com'} and {name:'email_verified',value:'true'} it
     * creates email alias and marks it as verified. Method ignores verifier attributes not paired with an alias attribute
     * and verifier attributes if {@link source} is 'user'.
     *
     * Following rules apply to alias attributes updates:
     * 1. User provided aliases are unverified.
     * 2. Unverified aliases replace each other. E.g. unverified B + unverified C = unverified C
     * 3. Verifying an unverified alias replaces old attribute with the new one. E.g. (verified A, unverified B) + verified B = verified B
     * 4. Verified aliases replace each other. E.g. verified A + verified B = verified B
     *
     * @example - provide and then confirm user email
     * const user = repo.fetchLocked('some username')
     * //book email alias preventing others to occupy it.
     * user.updateAttributes([{name:'email', value:'a@a.com'}], 'user')
     * //confirm email
     * user.updateAttributes([{name:'email', value:'a@a.com'}, {name:'email', value:'true'}], 'trusted')
     *
     * @param source - source of user attributes
     * @param updatedAttributes - user attributes
     */
    async updateAttributes(source: "user" | "trusted" = 'user', updatedAttributes: UserAttribute[]) {
        const {username, attributes} = this
        const context = {
            name: "updateAttributes",
            value: {
                username,
                attributes,
                updatedAttributes,
                source
            }
        }
        if (this.deleted) throw userNotFoundException().withContext(context)
        try {
            await this._updateAttributes(updatedAttributes, source, 'update');
        } catch (e: any) {
            throw errorWithContext(e, context)
        }
    }

    /**
     * Soft delete user while hard deleting its aliases.
     */
    async delete(force: boolean = false) {
        const {username, _attributes: attributes, deleted, store} = this
        const context = {
            name: "delete",
            value: {
                username,
                attributes,
                deleted
            }
        }
        const userTx = store.makeTransactBuilder(username)
        if (force) {
            for (const attr of attributes) {
                userTx.deleteAttribute(attr)
                if (attr.isAlias) {
                    userTx.deleteAliasRecord(attr)
                }
            }
            userTx.deleteUser()
        } else {
            for (const attr of attributes) {
                userTx.softDeleteAttribute(attr)
                if (attr.isAlias) {
                    userTx.deleteAliasRecord(attr)
                }
            }
            userTx.updateUser({deleted: true})
        }
        userTx.deleteAliasRecord({name: 'username', value: username, isAlias: true})
        try {
            await userTx.run()
        } catch (e: any) {
            throw internalServerError("Cannot delete user").withContext(context, {cause: e})
        }
        if (force) {
            this._attributes = []
        } else {
            this._attributes = this._attributes.map(x => ({
                ...x,
                value: x.isAlias ? undefined : x.value,
                unverifiedValue: x.isAlias ? x.value : undefined
            }))
        }
        this._deleted = true
    }

    /**
     * Delete attributes from a user. If alias attributes deleted then corresponding alias records delete as well.
     * @param attributes - attributes to delete
     */
    async deleteAttributes(attributes: string[]) {
        const {username, store} = this
        const context = {
            name: "deleteAttributes",
            value: {
                username,
                targetAttributes: attributes,
                attributes: this.attributes,
            }
        }
        if (this.deleted) throw userNotFoundException().withContext(context)
        const targetAttributes = new Set(attributes)
        const tx = store.makeTransactBuilder(username)
        for (const attribute of this._attributes) {
            if (targetAttributes.has(attribute.name)) {
                tx.deleteAttribute(attribute)
                if (attribute.isAlias) {
                    tx.deleteAliasRecord(attribute)
                }
            }
        }
        try {
            await tx.run()
        } catch (e: any) {
            throw internalServerError("Cannot delete attributes.").withContext(context, {cause: e})
        }
        this._attributes = this._attributes.filter(x => !targetAttributes.has(x.name))
    }

    private async _updateAttributes(sourceAttributes: UserAttribute[], source: "trusted" | "user", mode: 'update' | 'create') {
        const {username, store} = this

        /**
         * Prepare input attributes
         * 1. Map them into storage representation {@link UserAttributeItem} which is easy to merge.
         * 2. Override 'verified' flag based on attributes source.
         * 3. Validate names and values.
         */
        function prepareAttributes(attributes: UserAttribute[], trust: boolean): UserAttributeItem[] {
            const values = new Set<string>()
            const names = new Set<string>()
            return attributes.map(function (attribute) {
                const {name, value, verified} = attribute
                const isAlias = store.isAliasAttribute(name);
                if (isAlias) {
                    if (value === username || values.has(value)) {
                        throw invalidAliasException(attribute, {
                            details: "Alias attribute cannot be equal to username or another alias attribute value."
                        })
                    }
                    values.add(value)
                }
                if (names.has(name)) {
                    throw invalidAttributeException(attribute)
                }
                names.add(name)

                if (isAlias) {
                    return (verified && trust)
                        ? {name, value, isAlias: true}
                        : {name, unverifiedValue: value, isAlias: true}
                } else {
                    return {
                        name, value, isAlias: false
                    }
                }
            })
        }

        const input = prepareAttributes(sourceAttributes, source == 'trusted').sort(match)
        const userAttributes = this._attributes.toSorted(match)
        const tx = store.makeTransactBuilder(username)

        /**
         * Merge user attributes with input attributes to generate both resulting attributes and an update transaction.
         *
         * Let user (X, Y) to designate an alias attribute with value:A and unverifiedValue:B. (X, 0) is verified alias
         * without any unverified value. (0, Y) is an unverified alias. Then merge is as follows:
         * ```
         *  User + Input = Result
         * --------------------------
         * (A 0) + (C 0) = (C 0)
         * (A 0) + (0 C) = (A C)
         * (0 A) + (C 0) = (C A)
         * (0 A) + (0 C) = (0 C)
         * (A B) + (C 0) = (C B)
         * (A C) + (C 0) = (C 0) - this one is non-trivial: verify previously unverified attribute.
         * (A B) + (0 C) = (A C)
         * ```
         */
        function mergeAttributes(row: MergePair<UserAttributeItem>) {
            //keep in mind that newAttribute can have either value or unverifiedValue by construction.
            switch (row.type) {
                case 'left': {
                    const {left} = row
                    return left
                }
                case 'right': {
                    const {right} = row
                    tx.updateAttribute(right)
                    tx.refreshAliasRecord(right)
                    return right
                }
                case 'both': {
                    const {left, right} = row
                    let merged: UserAttributeItem
                    if (right.value !== undefined) {
                        if (left.value === right.value) {
                            return left
                        }
                        tx.deleteAliasRecord(left, 'verified')
                        tx.refreshAliasRecord(right, 'verified')
                        //edge case detailed above - (A C) + (C 0) = (C 0)
                        const unverifiedValue = right.value === left.unverifiedValue
                            ? undefined
                            : left.unverifiedValue
                        merged = {...left, value: right.value, unverifiedValue}
                    } else if (right.unverifiedValue !== undefined) {
                        if (left.unverifiedValue === right.unverifiedValue ||
                            left.value === right.unverifiedValue) {
                            return left
                        }
                        tx.deleteAliasRecord(left, 'unverified')
                        tx.refreshAliasRecord(right, 'unverified')
                        merged = {...left, unverifiedValue: right.unverifiedValue}
                    } else {
                        merged = left
                    }
                    tx.updateAttribute(merged)
                    return merged
                }
            }
        }

        const join = mergeJoin(userAttributes, input, match)
        const attributes = Array.from(join, mergeAttributes)
        if (attributes.length > this.store.maxAttributes) {
            throw tooManyUserAttributes()
        }
        if (mode === 'create') {
            tx.createUser()
            tx.refreshAliasRecord({name: 'username', value: username, isAlias: true})
        }
        const context = {
            name: '_updateAttributes'
        }
        try {
            await tx.run()
        } catch (e: any) {
            if (e instanceof TransactionCanceledException) {
                const cause = {cause: e, cancellationReasons: e.CancellationReasons}
                const expectedError = _.every(e.CancellationReasons, function ({Code}) {
                    return Code === "None" || Code === "ConditionalCheckFailed"
                })
                if (expectedError) {
                    if (mode === 'create') throw userExistsError()
                        .withContext(context, cause)
                    throw invalidAliasException()
                        .withContext(context, cause)
                }
                throw internalServerError("TransactionCanceledException due to an unexpected condition.")
                    .withContext(context, cause)
            }
            throw internalServerError(e.message)
                .withContext(context, {cause: e})
        }
        this._attributes = attributes

        function match({name: x}: UserAttributeItem, {name: y}: UserAttributeItem): number {
            return x < y ? -1 : (x == y ? 0 : 1)
        }
    }
}

function userNotFoundException() {
    return new AppError("User does not exist.", {
        name: 'UserNotFoundException',
        statusCode: '400'
    })
}

function userExistsError() {
    return new AppError("Username or alias already exists.", {
        name: 'UsernameExistsException',
        statusCode: '400'
    })
}

function tooManyUserAttributes() {
    return new AppError("Too many user attributes.", {
        name: 'TooManyUserAttributes',
        statusCode: '400',
        error: {
            schema: Schemas.UserAttributes,
        }
    })
}

export function invalidAliasException(attr?: UserAttribute, details?: any) {
    return new AppError("Invalid alias attribute.", {
        ...details,
        value: attr,
        name: "InvalidAliasException",
        statusCode: '400'
    })
}

function invalidAttributeException(attr?: UserAttribute, details?: any) {
    return new AppError("Invalid attribute.", {
        ...details,
        value: attr,
        name: "InvalidAttributeException",
        statusCode: '400'
    })
}
