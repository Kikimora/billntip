import {makeTestHandler, prepare} from "@app/test";
import {__init, handler} from "./tip";
import billFixture, {locations} from "./bill.fixture"

const fixture = prepare('Once', {
    async before() {
        const {tipUsers} = await __init()
        const {org: {pk, title}, store, normalUser, adminUser, businessAdminUser, userSession} = billFixture()
        //START - This should be done using registration endpoint
        const user = tipUsers.newUser(normalUser)
        await user.fetchOrCreate()
        await user.save()

        //END - This should be done using registration endpoint
        const location = await locations.create({
            path: {orgId: pk},
            body: {
                title: "My Location",
                image_url: "https://static.billntip.com/locations/abc.jpeg"
            }
        })
        //START - This should be done using invite endpoint
        await store.inviteToOrg({
            invited_by: adminUser,
            org: {
                id: pk,
                title: title
            },
            role: "admin",
            username: user.username
        })
        //END - This should be done using invite endpoint

        //START - This should be done using accept invite endpoint in tip
        await user.acceptInvite(pk)
        //END - This should be done using accept invite endpoint in tip
        return {tipUsers, user, location, billStore: store, normalUser, adminUser, businessAdminUser, userSession}
    },
    async after({user, location}) {
        await user.removeMembership(location.org_id)
        await user.delete()
        await locations.cleanupLocations()
        await locations.cleanupUserLocations()
    }
})

const getUserLocations = makeTestHandler(handler, function () {
    const {userSession} = fixture()
    return {
        routeKey: 'GET /tip/locations',
        authorizer: userSession('normalUser')
    }
})

describe("GET /tip/locations", () => {

    afterEach(locations.cleanupUserLocations)

    it("returns empty response", async () => {
        const response = await getUserLocations({})
        expect(response).toBeArray()
        expect(response).toBeEmpty()
    })

    it("returns assigned locations", async () => {
        const {user, location} = fixture()
        await locations.patch({
            path: {orgId: location.org_id, id: location.id},
            body: {
                addUser: user.username
            }
        })
        const response = await getUserLocations({})
        expect(response).toBeArray()
        expect(response).not.toBeEmpty()
    })

    enforcesAccessRules(function (authorizer) {
        return getUserLocations({authorizer})
    })
})


function enforcesAccessRules(request: (authorizer: any) => Promise<any>) {
    it("enforces access rules: 403 to unregistered users", async () => {
        const {userSession} = fixture()
        const response = await request(userSession('normalUser', {
            profile: {
                "cognito:groups": []
            }
        }))
        expect(response.statusCode).toBe("403")
    })
    it("enforces access rules: 200 to registered users", async () => {
        const {userSession} = fixture()
        const response = await request(userSession('normalUser'))
        if ('statusCode' in response) {
            expect(response.statusCode).toBe("200")
        } else {
            expect(response).toBeTruthy()
            expect(response.statusCode).toBeUndefined()
            expect(response.body).toBeUndefined()
        }
    })
}