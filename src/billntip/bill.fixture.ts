import {makeTestHandler, prepare, cognito, clearMock, MockResult} from "@app/test";
import {__init, handler} from "@src/billntip/bill";
import {User} from "@src/users/user";
import {uuid} from "short-uuid";
import {TestSessionOptions} from "@app/test/cognito";
import _ from "lodash";

export const locations = {
    getAll: makeTestHandler(handler, function () {
        const {userSession} = init()
        return {
            routeKey: 'GET /bill/{orgId}/locations',
            authorizer: userSession('adminUser')
        }
    }),

    get: makeTestHandler(handler, function () {
        const {userSession} = init()
        return {
            routeKey: 'GET /bill/{orgId}/locations/{id}',
            authorizer: userSession('adminUser')
        }
    }),

    create: jest.fn(makeTestHandler(handler, function () {
        const {userSession} = init()
        return {
            routeKey: 'POST /bill/{orgId}/locations',
            headers: {'content-type': 'application/json'},
            authorizer: userSession('adminUser')
        }
    })),

    put: makeTestHandler(handler, function () {
        const {userSession} = init()
        return {
            routeKey: 'PUT /bill/{orgId}/locations/{id}',
            headers: {'content-type': 'application/json'},
            authorizer: userSession('adminUser')
        }
    }),

    archive: makeTestHandler(handler, function () {
        const {userSession} = init()
        return {
            routeKey: 'DELETE /bill/{orgId}/locations/{id}',
            authorizer: userSession('adminUser')
        }
    }),

    patch: jest.fn(makeTestHandler(handler, function () {
        const {userSession} = init()
        return {
            routeKey: 'PATCH /bill/{orgId}/locations/{id}',
            headers: {'content-type': 'application/json'},
            authorizer: userSession('adminUser')
        }
    })),

    async cleanupLocations() {
        const {store} = init()
        for (const result of locations.create.mock.results) {
            if (result.type !== 'return') continue
            const location = await result.value
            await store.removeLocation(location.org_id, location.id)
        }
        locations.create.mockClear()
    },

    async cleanupUserLocations() {
        const {store} = init()
        for (const result of locations.patch.mock.results) {
            if (result.type !== 'return') continue
            const userLocation = await result.value
            await store.removeUserFromLocation(userLocation.id, userLocation.user_id)
        }
        locations.patch.mockClear()
    }
}

const init = prepare('Once', {
    async before() {
        const {store, userRepo} = await __init()

        const createUser = jest.spyOn(userRepo, 'create')
        const createLockedUser = jest.spyOn(userRepo, 'createLocked')

        const normalUser = `normal-user-${uuid()}`
        await userRepo.create(normalUser, "trusted", [
            {name: "email", value: `${normalUser}@example.com`, verified: true}
        ])
        const adminUser = `admin-user-${uuid()}`
        await userRepo.create(adminUser, "trusted", [
            {name: "email", value: `${adminUser}@example.com`, verified: true},
            {name: "first_name", value: "Super", verified: true},
            {name: "last_name", value: "Admin", verified: true}
        ])
        const businessAdminUser = `business-admin-user-${uuid()}`
        await userRepo.create(businessAdminUser, "trusted", [
            {name: "email", value: `${businessAdminUser}@example.com`, verified: true},
            {name: "first_name", value: "Business", verified: true},
            {name: "last_name", value: "Admin", verified: true}
        ])
        const businessUser = `business-user-${uuid()}`
        await userRepo.create(businessUser, "trusted", [
            {name: "email", value: `${businessUser}@example.com`, verified: true},
            {name: "first_name", value: "Business", verified: true},
            {name: "last_name", value: "User", verified: true}
        ])

        const createOrg = jest.spyOn(store, 'createOrg')
        const inviteToOrg = jest.spyOn(store, 'inviteToOrg')

        const org = await store.createOrg({
            title: "Test Org"
        })
        await store.inviteToOrg({
            invited_by: adminUser,
            org: {
                id: org.pk,
                title: org.title
            },
            role: "admin",
            username: businessAdminUser
        })
        const acceptInvite = await store.acceptInvite(businessAdminUser, org.pk)

        function userSession(user: 'normalUser' | 'businessAdminUser' | 'adminUser' | 'businessUser', options?: TestSessionOptions) {
            const fixture = init()
            switch (user) {
                case "adminUser":
                    options = _.defaults(options, {
                        profile: {
                            "cognito:groups": ["admin"]
                        }
                    })
                    break
                case "normalUser":
                    options = _.defaults(options, {
                        profile: {
                            "cognito:groups": ["recipient"]
                        }
                    })
                    break
                case "businessUser":
                    options = _.defaults(options, {
                        profile: {
                            "cognito:groups": ["business"]
                        }
                    })
                    break
                case "businessAdminUser":
                    options = _.defaults(options, {
                        profile: {
                            "cognito:groups": ["business"]
                        }
                    })
                    break
            }
            return {
                lambda: cognito.newSession(fixture[user], options)
            }
        }

        return {
            org,
            store,
            createUser,
            createLockedUser,
            createOrg,
            inviteToOrg,
            acceptInvite,
            normalUser,
            adminUser,
            businessAdminUser,
            businessUser,
            userSession
        }
    },
    async after({store, createUser, createLockedUser, createOrg, inviteToOrg}) {
        await locations.cleanupUserLocations()
        await locations.cleanupLocations()
        await clearMock(inviteToOrg, async function ({value: membership}) {
            if (membership !== undefined)
                await store.removeMembership(membership.pk, membership.sk)
        })
        await clearMock(createOrg, async function ({value: org}) {
            if (org !== undefined)
                await store.removeOrg(org.pk)
        })
        const deleteUser = async function ({value: user}: MockResult<User>) {
            if (user !== undefined) {
                await store.removeMember(user.username)
                await user.delete(true)
            }
        };
        await clearMock(createLockedUser, deleteUser)
        await clearMock(createUser, deleteUser)
    }
})

export default init
