import {prepare} from "@app/test";
import {uuid} from "short-uuid";
import fixture, {locations} from "./bill.fixture";

const locationRequest = {
    title: "My Location"
}

describe("POST /bill/{orgId}/locations", () => {

    const prepareForLocation = prepare('Once', async function () {
        const {org: {id}, uploadFile} = fixture()
        const img = await locations.image({
            path: {orgId: id},
        })
        const imgKey = await uploadFile(img)
        return {orgId: id, imgKey}
    })

    it("creates locations", async () => {
        const {orgId, imgKey} = prepareForLocation()
        const response = await locations.create({
            path: {orgId, },
            body: {...locationRequest, image: {id: imgKey}}
        })
        expect(response).toMatchObject({
            id: expect.toBeString(),
            org_id: orgId,
            title: "My Location",
            image: {
                id: `/images/${orgId}/locations/${response.id}.png`,
                version: expect.toBeNumber()
            },
            created_at: expect.toBeNumber(),
            updated_at: expect.toBeNumber(),
        })
        expect(response.created_at).toBeCloseTo(Date.now() / 1000, -1)
        expect(response.updated_at).toBeCloseTo(Date.now() / 1000, -1)
        expect(response.created_at).toBe(response.updated_at)
        expect(response.image.version / 1000).toBeCloseTo(response.updated_at)
    })

    validatesOrgId(function (path) {
        return locations.create({
            path,
            body: locationRequest
        })
    })

    enforcesAccessRules(function (authorizer) {
        const {org: {id}} = fixture()
        return locations.create({
            path: {orgId: id},
            body: locationRequest,
            authorizer
        })
    })

    validatesLocationRequestBody(function (body: any) {
        const {org: {id}} = fixture()
        return locations.create({
            path: {orgId: id},
            body
        })
    })
})

describe("PUT /bill/{orgId}/locations/{id}", () => {

    const createTestLocation = prepare('Once', {
        async before() {
            const {org: {id}, store, uploadFile} = fixture()
            const location = await locations.create({
                path: {orgId: id},
                body: {title: "ABC"}
            })
            const img = await locations.image({
                path: {orgId: id},
            })
            const imgKey = await uploadFile(img)
            return {orgId: id, store, location, imgKey}
        },
        async after() {
            await locations.cleanupLocations()
        }
    })

    it("updates locations", async () => {
        const {location, imgKey} = createTestLocation()
        const response = await locations.put({
            path: {orgId: location.org_id, id: location.id},
            body: {
                title: "Updated Title",
                image: {
                    id: imgKey
                }
            }
        })

        expect(response).toMatchObject({
            id: location.id,
            org_id: location.org_id,
            title: "Updated Title",
            image: {
                id: `/images/${location.org_id}/locations/${location.id}.png`,
                version: expect.toBeNumber()
            },
            created_at: expect.toBeNumber(),
            updated_at: expect.toBeNumber(),
        })
        expect(response.created_at).toBe(location.created_at)
        expect(response.updated_at).toBeCloseTo(Date.now() / 1000, -1)
        expect(response.image.version / 1000).toBeCloseTo(response.updated_at)
    })

    validatesOrgId(function (path) {
        const {location} = createTestLocation()
        return locations.put({
            path: {id: location.id, ...path},
            body: locationRequest
        })
    })

    validatesLocationId(function (path) {
        const {location} = createTestLocation()
        return locations.put({
            path: {orgId: location.org_id, ...path},
            body: locationRequest
        })
    })

    enforcesAccessRules(function (authorizer) {
        const {location} = createTestLocation()
        return locations.put({
            path: {orgId: location.org_id, id: location.id},
            body: locationRequest,
            authorizer
        })
    })

    validatesLocationRequestBody(function (body: any) {
        const {location} = createTestLocation()
        return locations.put({path: {orgId: location.org_id, id: location.id}, body})
    })
})

describe("GET /bill/{orgId}/locations", () => {

    const testLocations = prepare('Once', {
        async before() {
            const {org: {id}, store} = fixture()
            const abc = await locations.create({
                path: {orgId: id},
                body: {title: "ABC"}
            })
            const xyz = await locations.create({
                path: {orgId: id},
                body: {title: "XYZ"}
            })
            let archived = await locations.create({
                path: {orgId: id},
                body: {title: "Archived"}
            })
            archived = await locations.archive({
                path: {orgId: id, id: archived.id}
            })
            return {orgId: id, store, abc, xyz, archived}
        },
        async after() {
            await locations.cleanupLocations()
        }
    })

    enforcesAccessRules(function (authorizer) {
        const {orgId} = testLocations()
        return locations.getAll({path: {orgId}, authorizer})
    })

    it("returns locations", async () => {
        const {orgId, abc, xyz} = testLocations()
        const orgLocations = await locations.getAll({path: {orgId}})

        expect(orgLocations.data).toBeArrayOfSize(2)
        expect(orgLocations.data).toIncludeAllMembers([abc, xyz])
    })
    it("filters locations by title", async () => {
        const {orgId, abc} = testLocations()
        const orgLocations = await locations.getAll({path: {orgId}, query: {title: "a"}})
        expect(orgLocations.data).toBeArrayOfSize(1)
        expect(orgLocations.data).toIncludeAllMembers([abc])
    })
    it("filters locations by title and archival status", async () => {
        const {orgId, abc, archived} = testLocations()
        const orgLocations = await locations.getAll({path: {orgId}, query: {title: "a", archived: "true"}})
        expect(orgLocations.data).toBeArrayOfSize(2)
        expect(orgLocations.data).toIncludeAllMembers([abc, archived])
    })
})

describe("GET /bill/{orgId}/locations/{id}", () => {
    const createTestLocation = prepare('Once', {
        async before() {
            const {org: {id}, store} = fixture()
            const location = await locations.create({
                path: {orgId: id},
                body: {title: "ABC"}
            })
            return {orgId: id, store, location}
        },
        async after() {
            await locations.cleanupLocations()
        }
    })

    it("gets locations", async () => {
        const {location} = createTestLocation()
        const response = await locations.get({
            path: {orgId: location.org_id, id: location.id}
        })
        expect(response).toMatchObject({
            location,
            members: []
        })
    })

    validatesOrgId(function (path) {
        const {location} = createTestLocation()
        return locations.get({
            path: {id: location.id, ...path},
        })
    })

    validatesLocationId(function (path) {
        const {location} = createTestLocation()
        return locations.get({
            path: {orgId: location.org_id, ...path},
        })
    })

    enforcesAccessRules(function (authorizer) {
        const {location} = createTestLocation()
        return locations.get({
            path: {orgId: location.org_id, id: location.id},
            authorizer
        })
    })
})

describe("PATCH /bill/{orgId}/locations/{id}", () => {

    const createTestLocation = prepare('Once', {
        async before() {
            const {org: {id, title}, store} = fixture()
            const location = await locations.create({
                path: {orgId: id},
                body: {title: "ABC"}
            })
            await store.inviteToOrg({
                username: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a",
                role: "member",
                org: {
                    title,
                    id: id
                },
                invited_by: "business-admin"
            })
            await store.acceptInvite("37e17866-a0d9-4f4c-bde6-d5d1310f3f7a", id)

            return {orgId: id, store, location}
        },
        async after({orgId, store}) {
            await store.removeMembership("37e17866-a0d9-4f4c-bde6-d5d1310f3f7a", orgId)
            await store.removeMember("37e17866-a0d9-4f4c-bde6-d5d1310f3f7a")
            await locations.cleanupLocations()
        }
    })

    afterEach(locations.cleanupUserLocations)

    it("adds users to locations", async () => {
        const {location} = createTestLocation()
        const response = await locations.patch({
            path: {orgId: location.org_id, id: location.id},
            body: {addUser: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a"}
        })
        expect(response).toMatchObject({
            id: location.id,
            org_id: location.org_id,
            user_id: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a"
        })
    })

    it("removes users from locations", async () => {
        const {location} = createTestLocation()
        let response = await locations.patch({
            path: {orgId: location.org_id, id: location.id},
            body: {addUser: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a"}
        })
        expect(response).toBeObject()
        expect(response.statusCode).toBeUndefined()

        response = await locations.patch({
            path: {orgId: location.org_id, id: location.id},
            body: {removeUser: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a"}
        })
        expect(response).toEqual(expect.objectContaining({
            id: location.id,
            org_id: location.org_id,
            user_id: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a"
        }))
    })

    it.each([
        {
            condition: "empty request",
            body: {},
            responseBody: {message: "Request cannot be empty"}
        },
        {
            condition: "both addUser and removeUser are present",
            body: {addUser: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a", removeUser: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a"},
            responseBody: {
                message: "Cannot add and remove user in the same query"
            }
        },
        {
            condition: "user not found in the organisation",
            body: {addUser: uuid()},
            responseBody: {
                message: 'User is not a member of the organisation'
            }
        }
    ])("validates request body: 400 if $condition", async ({body, responseBody}) => {
        const {location} = createTestLocation()
        const response = await locations.patch({
            path: {orgId: location.org_id, id: location.id},
            body
        })
        expect(response.statusCode).toBe("400")
        expect(JSON.parse(response.body)).toMatchObject(responseBody)
    })

    validatesOrgId(function (path) {
        const {location} = createTestLocation()
        return locations.patch({
            path: {id: location.id, ...path},
            body: {addUser: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a"}
        })
    })

    validatesLocationId(function (path) {
        const {location} = createTestLocation()
        return locations.patch({
            path: {orgId: location.org_id, ...path},
            body: {addUser: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a"}
        })
    })

    enforcesAccessRules(function (authorizer) {
        const {location} = createTestLocation()
        return locations.patch({
            path: {orgId: location.org_id, id: location.id},
            body: {addUser: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a"},
            authorizer
        })
    })
})

describe("DELETE /bill/{orgId}/locations/{id}", () => {
    const createTestLocation = prepare('Once', {
        async before() {
            const {org: {id}, store} = fixture()
            const location = await locations.create({
                path: {orgId: id},
                body: {title: "ABC"}
            })
            return {orgId: id, store, location}
        },
        async after() {
            await locations.cleanupLocations()
        }
    })

    it("archives locations", async () => {
        const {location} = createTestLocation()
        const response = await locations.archive({
            path: {orgId: location.org_id, id: location.id}
        })
        expect(response).toEqual(expect.objectContaining({
            ...location,
            updated_at: expect.toBeNumber(),
            archived: true
        }))
        expect(response.updated_at).toBeCloseTo(Date.now() / 1000, -1)
        expect(response.updated_at).not.toEqual(response.created_at)
    })

    validatesOrgId(function (path) {
        const {location} = createTestLocation()
        return locations.archive({
            path: {id: location.id, ...path}
        })
    })

    validatesLocationId(function (path) {
        const {location} = createTestLocation()
        return locations.archive({
            path: {orgId: location.org_id, ...path},
        })
    })

    enforcesAccessRules(function (authorizer) {
        const {location} = createTestLocation()
        return locations.archive({
            path: {orgId: location.org_id, id: location.id},
            authorizer
        })
    })
})

function enforcesAccessRules(request: (authorizer: any) => Promise<any>) {
    it.each([
        {statusCode: "403", user: 'businessUser', group: "unrelated business users"},
        {statusCode: "403", user: 'normalUser', group: "normal users"},
    ])("enforces access rules: $statusCode to $group", async ({statusCode, user}) => {
        const {userSession} = fixture()
        const response = await request(userSession(user as any))
        expect(response.statusCode).toBe(statusCode)
    })
    it.each([
        {statusCode: "200", user: 'adminUser', group: "admins"},
        {statusCode: "200", user: 'businessAdminUser', group: "business admins"},
    ])("enforces access rules: $statusCode to $group", async ({user}) => {
        const {userSession} = fixture()
        const response = await request(userSession(user as any))
        expect(response).toBeObject()
        expect(response.statusCode).toBeUndefined()
        expect(response.body).toBeUndefined()
    })
}

function validatesOrgId(request: (path: Record<string, string>) => Promise<any>) {
    it.each([
        {case: "org id is empty", id: ""},
        //we use ABC org a lot :( forcing uuid here breaks manual testing
        //{case: "org id is not a uuid", id: "XYZ"}
    ])
    ("validates orgId: 400 if $case", async ({id}) => {
        const response = await request({orgId: id})
        expect(response.statusCode).toBe("400")
    })
    it("validates orgId: 404 if org is not found", async () => {
        const response = await request({orgId: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a"})
        expect(response.statusCode).toBe("404")
    })
}

function validatesLocationId(request: (path: Record<string, string>) => Promise<any>) {
    it.each([
        {case: "locations id is empty", id: ""},
        {case: "locations id is not a uuid", id: "XYZ"},
    ])
    ("validates id: 400 if $case", async ({id}) => {
        const response = await request({id})
        expect(response.statusCode).toBe("400")
    })
    it("validates id: 404 if locations is not found", async () => {
        const response = await request({id: "37e17866-a0d9-4f4c-bde6-d5d1310f3f7a"})
        expect(response.statusCode).toBe("404")
    })
}

function validatesLocationRequestBody(request: (body: any) => Promise<any>) {
    it.each([
        {
            prop: "image",
            value: {id: "/key/does/not/exists"},
            condition: "does not exists",
            error: "Invalid image key"
        },
        {
            prop: "image",
            value() {
                const {sampleImage} = fixture()
                return {
                    id: sampleImage
                }
            },
            condition: "exists, but does not belongs to the organization",
            error: "Invalid image key"
        },
        {prop: "title", value: null, condition: "is not present", error: "Expected string"},
        {
            prop: "title",
            value: "",
            condition: "is shorter than 1 character",
            error: "Expected string length greater or equal to 1"
        }
    ])("validates request body: 400 if $prop $condition", async ({prop, value, error}) => {
        const body: any = {...locationRequest}
        if (typeof value === 'function') value = value()
        body[prop] = value
        const response = await request(body)
        expect(response.statusCode).toBe("400")
        expect(JSON.parse(response.body)).toEqual(expect.objectContaining({
            message: error,
            "path": "/" + prop
        }))
    })
}
