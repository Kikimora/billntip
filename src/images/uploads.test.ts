import {generateImage} from 'js-image-generator'
import {CreateUploadResponse, handler, __init} from "@src/images/index";
import {cognito, prepare, makeTestHandler} from "@app/test";

const defaults = {
    headers: {'content-type': 'application/json'},
    authorizer: {lambda: cognito.newSession("test")}
}
const getUploads = makeTestHandler(handler, {
    routeKey: 'GET /uploads',
    ...defaults
})
const getUpload = makeTestHandler(handler, {
    routeKey: 'GET /upload/{id}',
    ...defaults
})
const deleteUpload = makeTestHandler(handler, {
    routeKey: 'DELETE /upload/{id}',
    ...defaults
})
const postUpload = makeTestHandler(handler, {
    routeKey: 'POST /uploads',
    ...defaults
})
const updateUpload = makeTestHandler(handler, {
    routeKey: 'POST /upload/{id}',
    ...defaults
})

describe("Uploads", () => {

    const fixture = prepare('Each', {
        async before() {
            return await __init()
        },
        async after() {
            const {files} = await getUploads({})
            for (const file of files) {
                await deleteUpload({path: {id: file}})
            }
        }
    })

    describe("POST /uploads", () => {
        it("return an upload URL with parameters", async () => {
            const {s3: {bucket}} = fixture()
            const response = await createUpload()
            expect(response).toEqual({
                type: 'profile_pic',
                id: expect.toBeString(),
                uploadUrl: `https://${bucket}.s3.eu-south-1.amazonaws.com/`,
                uploadFields: {
                    key: expect.stringMatching(`uploads/test/*`),
                    bucket,
                    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
                    'X-Amz-Credential': expect.toBeString(),
                    'X-Amz-Date': expect.toBeString(),
                    'X-Amz-Security-Token': expect.toBeString(),
                    Policy: expect.toBeString(),
                    'X-Amz-Signature': expect.toBeString()
                },
                expires: expect.toBeDateString()
            })
            const expiresIn = (Date.parse(response.expires) - Date.now()) / 1000
            expect(expiresIn).toBeCloseTo(5 * 60, -1)
        })
    })

    describe("POST /upload/{id}", () => {
        it("process (resize) uploaded images", async () => {
            const {s3: {cdnRoot}} = fixture()
            const uploadResponse = await createUpload()
            await uploadImage(uploadResponse)
            const imageResponse = await updateUpload({path: {id: uploadResponse.id}})
            const url = `https://static.${cdnRoot}/public/test/profile_pic.png`;
            expect(imageResponse).toEqual({
                type: 'profile_pic',
                id: 'profile_pic.png',
                contentType: 'image/png',
                url: url,
                image: {
                    height: 100,
                    width: 100
                }
            })
        })
    })

    describe("GET /uploads", () => {
        it("return uploads", async () => {
            const uploadResponse = await createUpload()
            await uploadImage(uploadResponse)
            await updateUpload({path: {id: uploadResponse.id}})
            const uploads = await getUploads({})
            expect(uploads).toEqual({
                lastKey: undefined,
                files: [
                    'profile_pic.png'
                ]
            })
        })
    })

    describe("GET /upload/{id}", () => {
        it("return upload", async () => {
            const {s3: {cdnRoot}} = fixture()
            const uploadResponse = await createUpload()
            await uploadImage(uploadResponse)
            const imageResponse = await updateUpload({path: {id: uploadResponse.id}})
            const upload = await getUpload({path: {id: imageResponse.id}})
            expect(upload).toEqual({
                contentType: 'image/png',
                type: 'profile_pic',
                id: 'profile_pic.png',
                url: `https://static.${cdnRoot}/public/test/profile_pic.png`,
                image: {width: 100, height: 100}
            })
        })
    })

    async function createUpload() {
        return await postUpload({body: {type: "profile_pic"}})
    }
})

async function uploadImage(response: CreateUploadResponse) {
    const imageBuffer = await new Promise<Buffer>(function (resolve, reject) {
        generateImage(400, 400, 0.5, function (err, img) {
            if (err) return reject(err)
            return resolve(img.data)
        })
    })
    const formData = new FormData();
    formData.append("Content-Type", "image/jpeg");
    Object.entries(response.uploadFields).forEach(([k, v]) => {
        formData.append(k, v);
    });
    formData.append('x-amz-meta-type', 'profile_pic')
    //use blob to upload data, simple call like
    //formData.append("file", imageBuffer);
    //does upload but result in a garbage bytes written to the S3 object.
    const blob = new Blob([imageBuffer], {type: "image/jpeg"})
    formData.append("file", blob, 'image.jpeg');
    const s3Response = await fetch(response.uploadUrl, {method: "POST", body: formData})
    expect(s3Response.status).toEqual(204)
    console.log(await s3Response.text())
    return imageBuffer;
}
