import {AppError, internalError, DDBLocks} from "@app/lambda";
import {TransactionCanceledException} from "@aws-sdk/client-dynamodb";
import _, {mergeJoin, MergePair} from "@app/util";
import {ErrorContext, errorWithContext} from "@app/diagnostics";
import * as Schemas from "./schemas";
import UserStore, {BatchFetchOptions, UserAttributeItem, UserItem, UserStoreOptions} from "./store";
import {UserAttribute} from "./attributes";

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

export {default as UserStore, UserItem, UserAttributeItem} from "./store"

export interface UserRepoOptions extends UserStoreOptions {
    /**
     * Locks table name
     */
    locks: string
}

/**
 * User data repository provides methods to load users from the storage.
 */
class UserRepo {
    private readonly store: UserStore
    readonly lockStore: DDBLocks.Store;

    get db() {
        return this.store.db
    }

    constructor(options: UserRepoOptions) {
        this.store = new UserStore(options)
        this.lockStore = DDBLocks.makeStore(options.locks, {dynamoDb: options.db})
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
        return this._lookupAlias(usernameOrAlias)
    }

    async _lookupAlias(usernameOrAlias: string, options?: FetchOptions) {
        const {store} = this

        if (options?.fetchDeleted) {
            return {
                username: usernameOrAlias,
                verified: true
            }
        }

        async function lookupAlias(usernameOrAlias: string) {
            try {
                return await store.lookupAlias(usernameOrAlias)
            } catch (e: any) {
                throw internalError(e.message).withContext({
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
     * Create user with attributes.
     * @param username - username provided by the user, must be globally unique.
     * @param source - attributes source
     * @param attributes - user attributes
     */
    create(username: string, source: "trusted" | "user" = 'user', attributes?: UserAttribute[]) {
        return this._create(username, false, source, attributes)
    }

    private async _create(username: string, lock: boolean, source: "trusted" | "user" = 'user', attributes?: UserAttribute[]) {
        const user = new User(username, this.store, this.lockStore)
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

    /**
     * Fetch only user attributes.
     * @param usernameOrAlias - username or alias
     * @param options - fetch options
     */
    async fetchAttributes(usernameOrAlias: string, options?: FetchOptions) {
        const {store} = this
        const {username, verified} = await this._lookupAlias(usernameOrAlias, options)

        const context: ErrorContext = {
            name: "fetch",
            value: {
                usernameOrAlias,
                options,
                username,
                verified
            }
        };

        if (!verified && !(options?.allowUnverifiedAlias ?? false)) {
            throw userNotFoundException().withContext(context)
        }

        try {
            const users = await store.batchFetch([username], { fetchDeleted: options?.fetchDeleted })
            return users[0]
        } catch (e: any) {
            throw internalError(e.message).withContext(context, {cause: e})
        }
    }

    /**
     * Fetch batch of users. This method makes one query for each username.
     * @param users - array of usernames, max 50
     * @param options - fetch options
     */
    async batchFetch(users: string[], options?: BatchFetchOptions): Promise<UserItem[]> {
        if (users.length === 0) return []
        if (users.length > 50)
            throw internalError("Too many users in a batch").withContext("batchFetch", {users, options})
        try {
            return await this.store.batchFetch(users, options)
        } catch (e: any) {
            throw internalError().withContext("batchFetch", {cause:e, users, options})
        }
    }

    private async _fetch(usernameOrAlias: string, lock: boolean, options?: FetchOptions) {
        const {username, verified} = await this._lookupAlias(usernameOrAlias, options)

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

        const user = new User(username, this.store, this.lockStore)

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
    }
}

function attributeMap(attributes: UserAttributeItem[]) {
    return _(attributes)
        .filter(function (x): x is { name: string, value: string } {
            return x.value !== undefined
        })
        .keyBy('name')
        .mapValues('value')
        .value();
}

export class User {
    private _attributes: UserAttributeItem[] = []
    private _deleted: boolean = false

    private _lock?: DDBLocks.Handle;

    constructor(public readonly username: string,
                private readonly store: UserStore,
                private readonly lockStore: DDBLocks.Store,) {
        this._attributes = []
    }

    private get lockOwner() {
        //AWS_LAMBDA_LOG_STREAM_NAME contains execution environment name
        //which makes good lock owner name
        return process.env.AWS_LAMBDA_LOG_STREAM_NAME ?? "noname"
    }

    get item(): UserItem {
        return {
            id: this.username,
            attributes: this.attributeMap,
            deleted: this.deleted
        }
    }

    attr(name: string, verified?: boolean) {
        return this.attributes.find(x => x.name === name && x.verified === verified)?.value
    }

    get attributeMap() {
        return _(this.attributes)
            .filter(x => 'verified' in x && x.verified || !('verified' in x))
            .keyBy('name')
            .mapValues('value')
            .value()
    }

    get attributes(): UserAttribute[] {
        return Array.from(makeAttributes(this._attributes))

        function* makeAttributes(attributes: UserAttributeItem[]): Generator<UserAttribute> {
            for (const attr of attributes) {
                if (attr.isAlias) {
                    if (attr.value !== undefined) {
                        yield {
                            name: attr.name,
                            value: attr.value,
                            verified: true,
                        }
                    }
                    if (attr.unverifiedValue !== undefined) {
                        yield {
                            name: attr.name,
                            value: attr.unverifiedValue,
                            verified: false,
                        }
                    }
                } else {
                    yield {
                        name: attr.name,
                        value: attr.value ?? "",
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
        const {username, lockStore, lockOwner} = this
        this._lock = await lockStore.tryLock(username, lockOwner, {
            leaseDuration: 1000,
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
                throw internalError(e.message).withContext(context, {cause: e})
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
     * @param force - force user hard delete
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
            throw internalError("Cannot delete user").withContext(context, {cause: e})
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
        const map: Record<string, string> = {}
        for (const attribute of this._attributes) {
            if (targetAttributes.has(attribute.name)) {
                tx.deleteAttribute(attribute)
                if (attribute.isAlias) {
                    tx.deleteAliasRecord(attribute)
                }
            } else if (attribute.value !== undefined) {
                map[attribute.name] = attribute.value
            }
        }
        tx.updateUser({attributes: map})
        try {
            await tx.run()
        } catch (e: any) {
            throw internalError("Cannot delete attributes.").withContext(context, {cause: e})
        }
        this._attributes = this._attributes.filter(x => !targetAttributes.has(x.name))
    }

    private async _updateAttributes(sourceAttributes: UserAttribute[], source: "trusted" | "user", mode: 'update' | 'create') {
        const {username, store} = this

        /**
         * Prepare input attributes:
         * 1. Map them into storage representation {@link UserAttributeItem} which is easy to merge.
         * 2. Override 'verified' flag based on attributes source.
         * 3. Validate names and values: alis cannot be equal to another alias or username, duplicate names are not allowed.
         * 4. Map empty string values to undefined. Attribute values used as a secondary key sort key and empty sort
         * keys are not allowed. Using undefined as a value removes value attribute from the item instead if creating
         * an empty string.
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
                if (_.isEmpty(name)) {
                    throw invalidAttributeException(attribute)
                }
                names.add(name)

                const attrValue = _.isEmpty(value) ? undefined : value
                const item: UserAttributeItem = {name}
                if (isAlias) {
                    item.isAlias = isAlias
                    if (verified && trust)
                        item.value = attrValue
                    else
                        item.unverifiedValue = attrValue
                } else {
                    item.value = attrValue
                }
                return item
            })
        }

        const input = prepareAttributes(sourceAttributes, source == 'trusted').sort(match)
        const userAttributes = this._attributes.toSorted(match)
        const tx = store.makeTransactBuilder(username)

        /**
         * Merge user attributes with input attributes to generate both resulting attributes and an update transaction.
         *
         * Let user (A, B) to designate an alias attribute with value:A and unverifiedValue:B. (X, 0) is verified alias
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
                        merged = right
                    }
                    tx.updateAttribute(merged)
                    return merged
                }
            }
        }

        const join = mergeJoin(userAttributes, input, match)
        const attributes = Array.from(join, mergeAttributes).filter(x => x.value !== '')
        if (attributes.length > this.store.maxAttributes) {
            throw tooManyUserAttributes()
        }
        const map = attributeMap(attributes)
        if (mode === 'create') {
            tx.createUser(map)
            tx.refreshAliasRecord({name: 'username', value: username, isAlias: true})
        } else {
            tx.updateUser({attributes: map})
        }
        const context = {
            name: '_updateAttributes'
        }
        try {
            await tx.run()
        } catch (e: any) {
            if (e instanceof TransactionCanceledException) {
                const cancellationReasons = e.CancellationReasons?.toReversed() ?? [];
                let errorContext
                if (mode === 'create') {
                    const [createUsernameAlias, createUser, ...attributes] = cancellationReasons
                    errorContext = {
                        cause: e,
                        createUser,
                        createUsernameAlias,
                        attributes
                    }
                    if (createUser.Code === 'ConditionalCheckFailed')
                        throw userExistsError().withContext(context, errorContext)
                } else {
                    const [updateUser, ...attributes] = cancellationReasons
                    errorContext = {
                        cause: e,
                        updateUser,
                        attributes
                    }
                }
                if (_.some(errorContext.attributes, x => x.Code === 'ConditionalCheckFailed')) {
                    throw invalidAliasException().withContext(context, errorContext)
                }
                throw internalError(e.message).withContext(context, errorContext)
            }
            throw internalError(e.message)
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

//See https://youtrack.jetbrains.com/issue/WEB-68793/Member-variable-incorrectly-highlighted-as-unused
export default UserRepo;
