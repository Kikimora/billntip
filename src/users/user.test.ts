import {DynamoDB} from "@aws-sdk/client-dynamodb";
import * as uuid from "uuid"
import UserRepo, {UserAttribute, User} from "./user";
import {Tracer} from "@app/diagnostics";

const dynamodb = new DynamoDB()
describe("User", () => {

    let repo!: UserRepo
    let user!: User
    let anotherUser: User
    beforeEach(async () => {
        const req = {
            tracer: new Tracer("test"),
            requestContext: {requestId: uuid.v4()}
        }
        repo = new UserRepo({
            tracer: req.tracer,
            tag: "test",
            db: dynamodb,
            aliasAttributes: ['email', 'phone_number', 'alt_email']
        })

        const cleanup = ['user.test.user@example.com', 'user.test@example.com', 'user.test.anotherUser@example.com', 'user.test.new@example.com']
            .map(async function (uname) {
                try {
                    console.log('Cleanup: ', uname)
                    const user = await repo.fetch(uname, {allowUnverifiedAlias: true, fetchDeleted: true})
                    console.log('Cleanup: Found ', uname)
                    await user.delete(true)
                    console.log('Cleanup: Deleted ', uname)
                } catch (e: any) {
                    if (e.name !== 'UserNotFoundException') {
                        console.log('Cleanup: Not Found ', uname, e.name, e.message)
                    }
                    console.log('Cleanup: Not Found ', uname)
                }
            })
        await Promise.all(cleanup)
    })
    afterEach(async () => {
        if (user !== undefined) {
            await user.unlock()
            await user.delete(true)
        }
        if (anotherUser !== undefined) {
            await anotherUser.unlock()
            await anotherUser.delete(true)
        }
    })

    describe("create", () => {
        it("creates new user", async () => {
            user = await repo.create("test", 'user', [
                {name: "attr", value: "value"}
            ])
            expect(user.isLocked).toBeFalse()
            await verifyAttributes([
                {name: "attr", value: "value"},
            ])
        })
        it("creates locked user if requested", async () => {
            user = await repo.createLocked("test")
            expect(user.isLocked).toBeTrue()
        })
        it("creates new user", async () => {
            user = await repo.create("test", 'user', [
                {name: "attr", value: "value"}
            ])
            expect(user.isLocked).toBeFalse()
            await verifyAttributes([
                {name: "attr", value: "value"},
            ])
        })
        it.each([
            {
                title: "ignores verified flag coming from untrusted source",
                attr: {name: "email", value: "user.test@example.com", verified: true},
                from: "user",
                result: {name: "email", value: "user.test@example.com", verified: false}
            },
            {
                title: "accept verified flag coming from trusted source",
                attr: {name: "email", value: "user.test@example.com", verified: true},
                from: "trusted",
                result: {name: "email", value: "user.test@example.com", verified: true}
            },
            {
                title: "ignores verified flag set on a normal (not alias) attribute coming from trusted source",
                attr: {name: "attr", value: "value", verified: true},
                from: "trusted",
                result: {name: "attr", value: "value"}
            },
        ])("$title", async ({attr, from, result}) => {
            user = await repo.create("test", from as any, [attr])
            await verifyAttributes([result])
        })
        it("alias cannot be equal to a username", async () => {
            const createTask = repo.create("user.test.user@example.com", 'user', [
                {name: "email", value: "user.test.user@example.com", verified: false}
            ])
            await expect(createTask).rejects.toThrowError(expect.objectContaining({
                name: 'InvalidAliasException'
            }))
        })
        it("alias cannot be equal to another alias", async () => {
            const createTask = repo.create("test", 'user', [
                {name: "email", value: "user.test.user@example.com"},
                {name: "alt_email", value: "user.test.user@example.com"}
            ])
            await expect(createTask).rejects.toThrowError(expect.objectContaining({
                name: 'InvalidAliasException'
            }))
        })
        it("cannot create two users with same username", async () => {
            user = await repo.create("test")
            await expect(repo.create("test")).rejects.toThrowError(expect.objectContaining({
                name: 'UsernameExistsException'
            }))
        })
        it("alias cannot be equal to another alias of another user", async () => {
            user = await repo.create("test1", 'trusted', [{name: 'email', value: 'user.test.user@example.com'}])
            await expect(repo.create("test2", 'trusted', [{
                name: 'alt_email',
                value: 'user.test.user@example.com'
            }])).rejects.toThrowError(expect.objectContaining({
                name: 'UsernameExistsException'
            }))
        })
    })

    describe("lookupAlias", () => {

        beforeEach(async () => {
            user = await repo.createLocked("test", 'trusted', [
                {name: "email", value: "user.test@example.com", verified: true},
                {name: "phone_number", value: "+1123123123", verified: false},
            ])
        })
        it("return username if given username", async () => {
            const usr = await repo.lookupAlias("test")
            expect(usr).toEqual(expect.objectContaining({
                username: "test",
                verified: true
            }))
        })
        it.each([
            ["email", "user.test@example.com", true],
            ["phone_number", "+1123123123", false],
        ])("map %s to username", async (_, value, verified) => {
            const alias = await repo.lookupAlias(value)
            expect(alias).toEqual(expect.objectContaining({
                username: "test",
                verified
            }))
        })
    })

    describe("fetch", () => {
        beforeEach(async () => {
            user = await repo.create("test", 'trusted', [
                {name: "attr", value: "value"},
                {name: "email", value: "user.test@example.com", verified: true},
                {name: "phone_number", value: "+1123123123"},
            ])
        })
        it("fetches by username", async () => {
            const usr = await repo.fetch("test")
            expect(usr).toBeObject()
        })
        it("fetches by verified alias", async () => {
            const usr = await repo.fetch('user.test@example.com')
            expect(usr).toBeObject()
        })
        it("fetches by unverified alias", async () => {
            const usr = await repo.fetch("+1123123123", {allowUnverifiedAlias: true})
            expect(usr).toBeObject()
        })
        it("fetches soft deleted user", async () => {
            await user.delete()
            const usr = await repo.fetch("test", {fetchDeleted: true})
            expect(usr).toBeObject()
        })
        it("fetches unlocked", async () => {
            const usr = await repo.fetch("test")
            expect(usr.isLocked).toBeFalse()
        })
        it("fetches and locks if requested", async () => {
            await user.unlock()
            user = await repo.fetchLocked("test")
            expect(user.isLocked).toBeTrue()
        })
        it("fails if username not found", async () => {
            await expect(repo.fetch("unknown")).rejects.toEqual(expect.objectContaining({
                name: "UserNotFoundException"
            }))
        })
        it("fails if alias is not confirmed", async () => {
            await expect(repo.fetch("+1123123123")).rejects.toEqual(expect.objectContaining({
                name: "UserNotFoundException"
            }))
        })
        it("fails if user soft deleted", async () => {
            await user.delete()
            await expect(repo.fetch("test")).rejects.toEqual(expect.objectContaining({
                name: "UserNotFoundException"
            }))
        })
        it("fetches attributes and aliases", async () => {
            const usr = await repo.fetch("test")
            expect(usr.attributes).toContainValues([
                {name: "attr", value: "value"},
                {name: "email", value: "user.test@example.com", verified: true},
                {name: "phone_number", value: "+1123123123", verified: false}
            ])
        })
    })

    describe("updateAttributes", () => {

        beforeEach(async () => {
            user = await repo.create("user.user.test@example.com", 'trusted', [
                {name: "attr", value: "value"},
                {name: "email", value: "user.test.user@example.com", verified: true},
            ])
        })
        it("updates normal attributes", async () => {
            await user.updateAttributes('user', [
                {name: "attr", value: "new value"},
                {name: "new_attr", value: "value"}
            ])
            await verifyAttributes([
                {name: "attr", value: "new value"},
                {name: "new_attr", value: "value"},
                {name: "email", value: "user.test.user@example.com", verified: true},
            ])
        })
        it("creates new unconfirmed alias", async () => {
            await user.updateAttributes('user', [{name: "email", value: "user.test.new@example.com"}])
            await verifyAttributes([
                {name: "email", value: "user.test.new@example.com", verified: false},
                {name: "email", value: "user.test.user@example.com", verified: true},
                {name: "attr", value: "value"},
            ])
        })
        it("keep old alias until new alias is not confirmed", async () => {
            await user.updateAttributes('user', [{name: "email", value: "user.test.new@example.com"}])
            await expect(repo.fetch('user.test.user@example.com')).resolves.toBeObject()
            await expect(repo.fetch('user.test.new@example.com')).rejects.toThrow(expect.objectContaining({
                name: 'UserNotFoundException'
            }))
        })
        it("confirms alias", async () => {
            await user.updateAttributes('trusted', [
                {name: "email", value: "user.test.new@example.com", verified: true}
            ])
            await verifyAttributes([
                {name: "attr", value: "value"},
                {name: "email", value: "user.test.new@example.com", verified: true},
            ])
            expect(await repo.fetch('user.test.new@example.com')).toBeObject()
        })
        it("fails to update deleted user", async () => {
            await user.delete()
            await expect(user.updateAttributes('user', [{name: "email", value: "user.test.new@example.com"}]))
                .rejects.toThrowError(expect.objectContaining({
                    name: "UserNotFoundException"
                }))
        })
        it("alias cannot be equal to a username", async () => {
            const updateTask = user.updateAttributes('user', [
                {name: "email", value: user.username, verified: false}
            ])
            await expect(updateTask).rejects.toThrowError(expect.objectContaining({
                name: 'InvalidAliasException'
            }))
        })
        it("alias cannot be equal to another alias", async () => {
            const updateTask = user.updateAttributes('user', [
                {name: "alt_email", value: "user.test.user@example.com"}
            ])
            await expect(updateTask).rejects.toThrowError(expect.objectContaining({
                name: 'InvalidAliasException'
            }))
        })
        it("alias cannot be equal to an alias of another user", async () => {
            anotherUser = await repo.create('anotherUser', 'trusted', [
                {name: "email", value: "user.test.anotherUser@example.com"},
            ])
            const updateTask = user.updateAttributes('user', [
                {name: "email", value: "user.test.anotherUser@example.com"},
            ])
            await expect(updateTask).rejects.toThrowError(expect.objectContaining({
                name: 'InvalidAliasException'
            }))
        })
    })

    describe("deleteAttributes", () => {
        beforeEach(async () => {
            user = await repo.create("test", 'trusted', [
                {name: "attr1", value: "value"},
                {name: "attr2", value: "value"},
                {name: "email", value: "user.test@example.com", verified: true},
                {name: "phone_number", value: "+1123123123", verified: false},
            ])
        })
        it("deletes normal attributes", async () => {
            await user.deleteAttributes(['attr1', 'attr2'])
            await verifyAttributes([
                {name: "email", value: "user.test@example.com", verified: true},
                {name: "phone_number", value: "+1123123123", verified: false}
            ])
        })
        it("deletes aliases", async () => {
            await user.deleteAttributes(['email', 'phone_number'])
            await verifyAttributes([
                {name: "attr1", value: "value"},
                {name: "attr2", value: "value"}
            ])
        })
        it("fails to update deleted user", async () => {
            await user.delete()
            await expect(user.deleteAttributes(['attr1']))
                .rejects.toThrowError(expect.objectContaining({
                    name: "UserNotFoundException"
                }))
        })
    })

    describe("delete", () => {

        beforeEach(async () => {
            user = await repo.create("test", 'trusted', [
                {name: "attr1", value: "value"},
                {name: "attr2", value: "value"},
                {name: "email", value: "user.test@example.com", verified: true},
            ])
        })

        it("soft delete removes aliases and keeps attributes", async () => {
            await user.delete()
            expect(user.deleted).toBeTrue()
            await verifyAttributes([
                {name: "attr1", value: "value"},
                {name: "attr2", value: "value"},
                {name: "email", value: "user.test@example.com", verified: false}
            ])
            //verifyAttributes reload user from storage, below line checks if deleted flag saved
            expect(user.deleted).toBeTrue()
            //can fetch with allowDeleted
            await expect(repo.fetch("test", {fetchDeleted: true})).resolves.toBeObject()
            //cannot fetch otherwise
            await expect(repo.fetch("test")).rejects.toThrowError(expect.objectContaining({
                name: "UserNotFoundException"
            }))
        })

        it("hard delete removes aliases and attributes", async () => {
            await user.delete(true)

            expect(user.deleted).toBeTrue()
            expect(user.attributes).toEqual([])
            await expect(repo.fetch("test")).rejects.toThrowError(expect.objectContaining({
                name: "UserNotFoundException"
            }))

            user = await repo.create('test')
            await verifyAttributes([])
            expect(user.deleted).toBeFalse()
        })
    })

    async function verifyAttributes(expectedAttributes: UserAttribute[]) {
        expect(user.attributes).toContainAllValues(expectedAttributes)
        await user.fetch()
        expect(user.attributes).toContainAllValues(expectedAttributes)
    }
})
