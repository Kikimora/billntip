import UserRepo, {UserAttribute, User} from "./user";
import {__init} from "./index";
import {clearMock, prepare} from "@app/test/util"
import {uuid} from "short-uuid";
import {DynamoDB, QueryCommandOutput} from "@aws-sdk/client-dynamodb";

const fixture = prepare('Once', {
    async before() {
        const {dynamodb, options} = await __init()
        //Do not use userRepo from __init since it does not have alt_email alias which is needed for tests
        const repo = new UserRepo({
            db: dynamodb,
            aliasAttributes: ['email', 'phone_number', 'alt_email'],
            table: options.dynamodb.users,
            locks: options.dynamodb.locks
        })
        const createUser = jest.spyOn(repo, 'create')
        const createLockedUser = jest.spyOn(repo, 'createLocked')
        return {repo, createUser, createLockedUser}
    },

    async after() {
        await clearUsers()
    }
})

async function clearUsers() {
    const {createUser, createLockedUser} = fixture()

    const removeUser = async function (result: { value?: User }) {
        const {value: user} = result
        if (user !== undefined) {
            console.log("Remove ", user.username)
            if (user.isLocked)
                await user.unlock()
            await user.delete(true)
        }
    };
    await clearMock(createUser, removeUser)
    await clearMock(createLockedUser, removeUser)
}

it("Migrate Org Type info -> O", async () => {
    const table = "billntip-dev-data"
    const db = new DynamoDB()
    let next = undefined
    do {
        const result: QueryCommandOutput = await db.query({
            TableName: table,
            IndexName: "inverse",
            KeyConditionExpression: "#sk = :type",
            ExpressionAttributeValues: {
                ':type': {S: "info"}
            },
            ExpressionAttributeNames: {
                '#sk': 'sk'
            },
            ExclusiveStartKey: next,
            Limit: 25
        })
        next = result.LastEvaluatedKey
        const items = result.Items ?? []
        if (items.length === 0) continue
        await db.batchWriteItem({
            RequestItems: {
                [table]: items.map(function (org) {
                    return {
                        PutRequest: {
                            Item: {
                                ...org,
                                sk: {S: "O"},
                            }
                        }
                    }
                })
            }
        })
        await db.batchWriteItem({
            RequestItems: {
                [table]: items.map(function (org) {
                    return {
                        DeleteRequest: {
                            Key: {
                                pk: org.pk,
                                sk: org.sk,
                            }
                        }
                    }
                })
            }
        })
    } while (next !== undefined)
}, 60000)

it("Migrate user type M -> U", async () => {
    const table = "billntip-dev-data"
    const db = new DynamoDB()
    let next = undefined
    do {
        const result: QueryCommandOutput = await db.query({
            TableName: table,
            IndexName: "inverse",
            KeyConditionExpression: "#sk = :type",
            ExpressionAttributeValues: {
                ':type': {S: "M"}
            },
            ExpressionAttributeNames: {
                '#sk': 'sk'
            },
            ExclusiveStartKey: next,
            Limit: 25
        })
        next = result.LastEvaluatedKey
        const items = result.Items ?? []
        if (items.length === 0) continue
        await db.batchWriteItem({
            RequestItems: {
                [table]: items.map(function (org) {
                    return {
                        PutRequest: {
                            Item: {
                                ...org,
                                sk: {S: "U"},
                            }
                        }
                    }
                })
            }
        })
        await db.batchWriteItem({
            RequestItems: {
                [table]: items.map(function (org) {
                    return {
                        DeleteRequest: {
                            Key: {
                                pk: org.pk,
                                sk: org.sk,
                            }
                        }
                    }
                })
            }
        })
    } while (next !== undefined)
}, 60000)


describe("User", () => {

    describe("create", () => {
        const userId = uuid()
        afterEach(clearUsers)
        it("creates new user", async () => {
            const {repo} = fixture()
            const user = await repo.create(`${userId}.test@example.com`, 'user', [
                {name: "attr", value: "value"}
            ])
            expect(user.isLocked).toBeFalse()
            await verifyAttributes(user, [
                {name: "attr", value: "value"},
            ])
        })
        it("creates locked user if requested", async () => {
            const {repo} = fixture()
            const user = await repo.createLocked(`${userId}.test@example.com`)
            expect(user.isLocked).toBeTrue()
        })
        it("creates new user", async () => {
            const {repo} = fixture()
            const user = await repo.create(`${userId}.test@example.com`, 'user', [
                {name: "attr", value: "value"}
            ])
            expect(user.isLocked).toBeFalse()
            await verifyAttributes(user, [
                {name: "attr", value: "value"},
            ])
        })
        it.each([
            {
                title: "ignores verified flag coming from untrusted source",
                attr: {name: "email", value: `${userId}.test@example.com`, verified: true},
                from: "user",
                result: {name: "email", value: `${userId}.test@example.com`, verified: false}
            },
            {
                title: "accept verified flag coming from trusted source",
                attr: {name: "email", value: `${userId}.test@example.com`, verified: true},
                from: "trusted",
                result: {name: "email", value: `${userId}.test@example.com`, verified: true}
            },
            {
                title: "ignores verified flag set on a normal (not alias) attribute coming from trusted source",
                attr: {name: "attr", value: "value", verified: true},
                from: "trusted",
                result: {name: "attr", value: "value"}
            },
        ])("$title", async ({attr, from, result}) => {
            const {repo} = fixture()
            const user = await repo.create("test", from as any, [attr])
            await verifyAttributes(user, [result])
        })
        it("alias cannot be equal to a username", async () => {
            const {repo} = fixture()
            const createTask = repo.create(`${userId}.new@example.com`, 'user', [
                {name: "email", value: `${userId}.new@example.com`, verified: false}
            ])
            await expect(createTask).rejects.toThrow(expect.objectContaining({
                name: 'InvalidAliasException'
            }))
        })
        it("alias cannot be equal to another alias", async () => {
            const {repo} = fixture()
            const createTask = repo.create(userId, 'user', [
                {name: "email", value: `${userId}.new@example.com`},
                {name: "alt_email", value: `${userId}.new@example.com`}
            ])
            await expect(createTask).rejects.toThrow(expect.objectContaining({
                name: 'InvalidAliasException'
            }))
        })
        it("cannot create two users with same username", async () => {
            const {repo} = fixture()
            await repo.create(userId)
            await expect(repo.create(userId)).rejects.toThrow(expect.objectContaining({
                name: 'UsernameExistsException'
            }))
        })
        it("alias cannot be equal to another alias of another user", async () => {
            const {repo} = fixture()
            await repo.create(userId, 'trusted', [{name: 'email', value: `${userId}.test@example.com`}])
            await expect(repo.create(uuid(), 'trusted', [{
                name: 'alt_email',
                value: `${userId}.test@example.com`
            }])).rejects.toThrow(expect.objectContaining({
                name: 'InvalidAliasException'
            }))
        })
    })

    describe("lookupAlias", () => {

        const userId = uuid()
        const createLockedUser = prepare('Once', {
            async before() {
                const {repo} = fixture()
                const user = await repo.createLocked(userId, 'trusted', [
                    {name: "email", value: `${userId}.test@example.com`, verified: true},
                    {name: "phone_number", value: `+${userId}`, verified: false},
                ])
                return {repo, user}
            },
            async after() {
                await clearUsers()
            }
        })

        it("return username if given username", async () => {
            const {repo} = createLockedUser()
            const usr = await repo.lookupAlias(userId)
            expect(usr).toEqual(expect.objectContaining({
                username: userId,
                verified: true
            }))
        })
        it.each([
            ["email", `${userId}.test@example.com`, true],
            ["phone_number", `+${userId}`, false],
        ])("map %s to username", async (_, value, verified) => {
            const {repo} = createLockedUser()
            const alias = await repo.lookupAlias(value)
            expect(alias).toEqual(expect.objectContaining({
                username: userId,
                verified
            }))
        })
    })

    describe("fetch", () => {

        const userId = uuid()
        const createUser = prepare('Once', {
            async before() {
                const {repo} = fixture()
                const user = await repo.create(userId, 'trusted', [
                    {name: "attr", value: "value"},
                    {name: "email", value: `${userId}.test@example.com`, verified: true},
                    {name: "phone_number", value: `+${userId}`},
                ])
                return {repo, user}
            },
            async after() {
                await clearUsers()
            }
        })

        it("fetches by username", async () => {
            const {repo} = createUser()
            const usr = await repo.fetch(userId)
            expect(usr).toBeObject()
        })
        it("fetches by verified alias", async () => {
            const {repo} = createUser()
            const usr = await repo.fetch(`${userId}.test@example.com`)
            expect(usr).toBeObject()
        })
        it("fetches by unverified alias", async () => {
            const {repo} = createUser()
            const usr = await repo.fetch(`+${userId}`, {allowUnverifiedAlias: true})
            expect(usr).toBeObject()
        })
        it("fetches soft deleted user", async () => {
            const {repo} = createUser()
            const userId = uuid()
            const user = await repo.create(userId)
            await user.delete()
            const usr = await repo.fetch(userId, {fetchDeleted: true})
            expect(usr).toBeObject()
        })
        it("fetches unlocked", async () => {
            const {repo} = createUser()
            const usr = await repo.fetch(userId)
            expect(usr.isLocked).toBeFalse()
        })
        it("fetches and locks if requested", async () => {
            const {repo, user} = createUser()
            await user.unlock()
            let lockedUser = await repo.fetchLocked(userId)
            expect(lockedUser.isLocked).toBeTrue()
        })
        it("fails if username not found", async () => {
            const {repo} = createUser()
            await expect(repo.fetch("unknown")).rejects.toEqual(expect.objectContaining({
                name: "UserNotFoundException"
            }))
        })
        it("fails if alias is not confirmed", async () => {
            const {repo} = createUser()
            await expect(repo.fetch(`+${userId}`)).rejects.toEqual(expect.objectContaining({
                name: "UserNotFoundException"
            }))
        })
        it("fails if user soft deleted", async () => {
            const {repo} = createUser()
            const userId = uuid()
            const user = await repo.create(userId)
            await user.delete()
            await expect(repo.fetch(userId)).rejects.toEqual(expect.objectContaining({
                name: "UserNotFoundException"
            }))
        })
        it("fetches attributes and aliases", async () => {
            const {repo} = createUser()
            const usr = await repo.fetch(userId)
            expect(usr.attributes).toContainValues([
                {name: "attr", value: "value"},
                {name: "email", value: `${userId}.test@example.com`, verified: true},
                {name: "phone_number", value: `+${userId}`, verified: false}
            ])
        })
    })

    describe("updateAttributes", () => {

        const userId = uuid()
        const createUser = prepare('Each', {
            async before() {
                const {repo} = fixture()
                const user = await repo.create(userId, 'trusted', [
                    {name: "attr", value: "value"},
                    {name: "email", value: `${userId}@example.com`, verified: true},
                ])
                return {repo, user}
            },
            async after() {
                await clearUsers()
            }
        })

        it("updates normal attributes", async () => {
            const {user} = createUser()
            await user.updateAttributes('user', [
                {name: "attr", value: "new value"},
                {name: "new_attr", value: "value"}
            ])
            await verifyAttributes(user, [
                {name: "attr", value: "new value"},
                {name: "new_attr", value: "value"},
                {name: "email", value: `${userId}@example.com`, verified: true},
            ])
        })
        it("creates new unconfirmed alias", async () => {
            const {user} = createUser()
            await user.updateAttributes('user', [{name: "email", value: `new.${userId}@example.com`}])
            await verifyAttributes(user, [
                {name: "email", value: `new.${userId}@example.com`, verified: false},
                {name: "email", value: `${userId}@example.com`, verified: true},
                {name: "attr", value: "value"},
            ])
        })
        it("keep old alias until new alias is not confirmed", async () => {
            const {user, repo} = createUser()
            await user.updateAttributes('user', [{name: "email", value: `new.${userId}@example.com`}])
            await expect(repo.fetch(`${userId}@example.com`)).resolves.toBeObject()
            await expect(repo.fetch(`new.${userId}@example.com`)).rejects.toThrow(expect.objectContaining({
                name: 'UserNotFoundException'
            }))
        })
        it("confirms alias", async () => {
            const {user, repo} = createUser()
            await user.updateAttributes('trusted', [
                {name: "email", value: `new.${userId}@example.com`, verified: true}
            ])
            await verifyAttributes(user, [
                {name: "attr", value: "value"},
                {name: "email", value: `new.${userId}@example.com`, verified: true},
            ])
            expect(await repo.fetch(`new.${userId}@example.com`)).toBeObject()
        })
        it("fails to update deleted user", async () => {
            const {user} = createUser()
            await user.delete()
            await expect(user.updateAttributes('user', [{name: "email", value: `${userId}@example.com`}]))
                .rejects.toThrowError(expect.objectContaining({
                    name: "UserNotFoundException"
                }))
        })
        it("alias cannot be equal to a username", async () => {
            const {user} = createUser()
            const updateTask = user.updateAttributes('user', [
                {name: "email", value: user.username, verified: false}
            ])
            await expect(updateTask).rejects.toThrowError(expect.objectContaining({
                name: 'InvalidAliasException'
            }))
        })
        it("alias cannot be equal to another alias", async () => {
            const {user} = createUser()
            const updateTask = user.updateAttributes('user', [
                {name: "alt_email", value: `${userId}@example.com`}
            ])
            await expect(updateTask).rejects.toThrowError(expect.objectContaining({
                name: 'InvalidAliasException'
            }))
        })
        it("alias cannot be equal to an alias of another user", async () => {
            const {user, repo} = createUser()
            const anotherUserId = uuid()
            await repo.create(anotherUserId, 'trusted', [
                {name: "email", value: `${anotherUserId}@example.com`},
            ])
            const updateTask = user.updateAttributes('user', [
                {name: "email", value: `${anotherUserId}@example.com`},
            ])
            await expect(updateTask).rejects.toThrowError(expect.objectContaining({
                name: 'InvalidAliasException'
            }))
        })
    })

    describe("deleteAttributes", () => {

        const userId = uuid()
        const createUser = prepare('Each', {
            async before() {
                const {repo} = fixture()
                const user = await repo.create(userId, 'trusted', [
                    {name: "attr1", value: "value"},
                    {name: "attr2", value: "value"},
                    {name: "email", value: `${userId}.test@example.com`, verified: true},
                    {name: "phone_number", value: `+${userId}`, verified: false},
                ])
                return {repo, user}
            },
            async after() {
                await clearUsers()
            }
        })

        it("deletes normal attributes", async () => {
            const {user} = createUser()
            await user.deleteAttributes(['attr1', 'attr2'])
            await verifyAttributes(user, [
                {name: "email", value: `${userId}.test@example.com`, verified: true},
                {name: "phone_number", value: `+${userId}`, verified: false}
            ])
        })
        it("deletes aliases", async () => {
            const {user} = createUser()
            await user.deleteAttributes(['email', 'phone_number'])
            await verifyAttributes(user, [
                {name: "attr1", value: "value"},
                {name: "attr2", value: "value"}
            ])
        })
        it("fails to update deleted user", async () => {
            const {user} = createUser()
            await user.delete()
            await expect(user.deleteAttributes(['attr1']))
                .rejects.toThrowError(expect.objectContaining({
                    name: "UserNotFoundException"
                }))
        })
    })

    describe("delete", () => {
        const userId = uuid()
        const createUser = prepare('Each', {
            async before() {
                const {repo} = fixture()
                const user = await repo.create(userId, 'trusted', [
                    {name: "attr1", value: "value"},
                    {name: "attr2", value: "value"},
                    {name: "email", value: `${userId}.test@example.com`, verified: true},
                ])
                return {repo, user}
            },
            async after() {
                await clearUsers()
            }
        })

        it("soft delete removes aliases and keeps attributes", async () => {
            const {user, repo} = createUser()
            await user.delete()
            expect(user.deleted).toBeTrue()
            await verifyAttributes(user, [
                {name: "attr1", value: "value"},
                {name: "attr2", value: "value"},
                {name: "email", value: `${userId}.test@example.com`, verified: false}
            ])
            //verifyAttributes reload user from storage, below line checks if deleted flag saved
            expect(user.deleted).toBeTrue()
            //can fetch with allowDeleted
            await expect(repo.fetch(userId, {fetchDeleted: true})).resolves.toBeObject()
            //cannot fetch otherwise
            await expect(repo.fetch(userId)).rejects.toThrowError(expect.objectContaining({
                name: "UserNotFoundException"
            }))
        })

        it("hard delete removes aliases and attributes", async () => {
            const {user, repo} = createUser()
            await user.delete(true)

            expect(user.deleted).toBeTrue()
            expect(user.attributes).toEqual([])
            await expect(repo.fetch(userId)).rejects.toThrowError(expect.objectContaining({
                name: "UserNotFoundException"
            }))

            const newUser = await repo.create(userId)
            await verifyAttributes(newUser, [])
            expect(newUser.deleted).toBeFalse()
        })
    })

    async function verifyAttributes(user: User, expectedAttributes: UserAttribute[]) {
        expect(user.attributes).toContainAllValues(expectedAttributes)
        await user.fetch()
        expect(user.attributes).toContainAllValues(expectedAttributes)
    }
})
