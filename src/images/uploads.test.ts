import {cognito, prepare, makeTestHandler, prepareWithContext} from "@app/test";
import {handler, __init} from "./index";
import fixture from "./uploads.fixture"

const defaults = {
    headers: {'content-type': 'application/json'},
    authorizer: {lambda: cognito.newSession("test")}
}

const createImageFromUpload = makeTestHandler(handler, {
    routeKey: 'POST /images',
    ...defaults
})

const init = prepare('Once', __init)
const testData = prepareWithContext('Each', init, fixture)

describe("Uploads", () => {

    describe("POST /images", () => {
        it("creates image from an upload", async () => {
            const {s3, makeUpload, uploadFile} = testData()
            const upload = await makeUpload("test")
            const key = await uploadFile(upload)
            const response = await createImageFromUpload({
                body: {key}
            })
            const url = `https://${s3.cdn}/test`;
            expect(response).toMatchObject({
                content_type: 'image/png',
                key: 'test',
                id: url
            })
            const imageRequest = await fetch(url)
            expect(imageRequest.status).toBe(200)
            const imgBytes = await imageRequest.arrayBuffer();
            expect(imgBytes.byteLength).toBeGreaterThan(1024)
        })
        // it("validates upload presence")
        // it("validates upload is an transformable image")
    })
})
