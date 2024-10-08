import _ from "lodash";
import {makeTestHandler, prepare, cognito, clearMock, MockResult, chainFixtures} from "@app/test";
import {User} from "@src/users/user";
import {uuid} from "short-uuid";
import {TestSessionOptions} from "@app/test/cognito";
import UploadsFixture from "@src/images/uploads.fixture";
import {__init, handler} from "./bill";

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

    image: jest.fn(makeTestHandler(handler, function () {
        const {userSession} = init()
        return {
            routeKey: 'POST /bill/{orgId}/locations/image',
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
        const {store, org} = init()
        for (const {value} of locations.patch.mock.results) {
            if (value === undefined) continue
            const userLocation = await value
            //Skip HTTP errors (they all have statusCode and body properties while responses are plain objects).
            if ('statusCode' in userLocation) continue
            await store.modifyUserLocation(org.id, userLocation.id, userLocation.user_id, 'delete')
        }
        locations.patch.mockClear()
    }
}

const env = chainFixtures(__init, UploadsFixture)
const init = prepare('Once', chainFixtures(env, {
    async before({store, profileRepo, uploadFile, makeUpload}) {

        const createUser = jest.spyOn(profileRepo, 'create')
        const createLockedUser = jest.spyOn(profileRepo, 'createLocked')

        const normalUser = `normal-user-${uuid()}`
        await profileRepo.create(normalUser, "trusted", [
            {name: "email", value: `${normalUser}@example.com`, verified: true}
        ])
        const adminUser = `admin-user-${uuid()}`
        await profileRepo.create(adminUser, "trusted", [
            {name: "email", value: `${adminUser}@example.com`, verified: true},
            {name: "first_name", value: "Super", verified: true},
            {name: "last_name", value: "Admin", verified: true}
        ])
        const businessAdminUser = `business-admin-user-${uuid()}`
        await profileRepo.create(businessAdminUser, "trusted", [
            {name: "email", value: `${businessAdminUser}@example.com`, verified: true},
            {name: "first_name", value: "Business", verified: true},
            {name: "last_name", value: "Admin", verified: true}
        ])
        const businessUser = `business-user-${uuid()}`
        await profileRepo.create(businessUser, "trusted", [
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
                id: org.id,
                title: org.title
            },
            role: "admin",
            username: businessAdminUser
        })
        const acceptInvite = await store.acceptInvite(businessAdminUser, org.id)

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

        const testFile = await makeUpload("upload/sample")
        const sampleImage = await uploadFile(testFile)

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
            userSession,
            sampleImage
        }
    },
    async after({store, createUser, createLockedUser, createOrg, inviteToOrg}) {
        await locations.cleanupUserLocations()
        await locations.cleanupLocations()
        await clearMock(inviteToOrg, async function ({value: membership}) {
            if (membership !== undefined)
                await store.removeMembership(membership.id, membership.orgId)
        })
        await clearMock(createOrg, async function ({value: org}) {
            if (org !== undefined)
                await store.removeOrg(org.id)
        })
        const deleteUser = async function ({value: user}: MockResult<User>) {
            if (user !== undefined) {
                await store.removeUser(user.username)
                await user.delete(true)
            }
        };
        await clearMock(createLockedUser, deleteUser)
        await clearMock(createUser, deleteUser)
    }
}))

export default init
