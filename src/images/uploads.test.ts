import {RequestBuilder, resources} from "@app/test/util";
import {generateImage} from 'js-image-generator'
import fs from "fs";

const {
    s3: {bucket: {id: Bucket}},
} = resources()
process.env.BUCKET = Bucket
process.env.AWS_REGION = "eu-south-1"
//Must be after process.env modifications
import {CreateUploadResponse, handler} from "@src/images/index";
import {newSession} from "@app/test/cognito";

const sub = "test"

describe("Uploads", () => {

    let request!: RequestBuilder
    beforeEach(() => {

        request = new RequestBuilder({functionName: "images", functionVersion: "Test"})
            .lambdaAuth(newSession("test"))
    })

    afterEach(async () => {
        const {files} = await request
            .route('GET /uploads')
            .run(handler)
        for (const file of files) {
            await request
                .route('DELETE /upload/{id}', {id: file})
                .run(handler)
        }
    })

    describe("POST /uploads", () => {
        it("return an upload URL with parameters", async () => {
            const response = await createUpload()
            expect(response).toEqual({
                type: 'profile_pic',
                id: expect.toBeString(),
                uploadUrl: `https://${Bucket}.s3.eu-south-1.amazonaws.com/`,
                uploadFields: {
                    key: expect.stringMatching(`uploads/${sub}/*`),
                    bucket: Bucket,
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
            const uploadResponse = await createUpload()
            await uploadImage(uploadResponse)
            const imageResponse = await request
                .route('POST /upload/{id}', {id: uploadResponse.id})
                .run(handler)
            const url = `https://${Bucket}.s3.eu-south-1.amazonaws.com/public/${sub}/profile_pic.png`;
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
            await request
                .route('POST /upload/{id}', {id: uploadResponse.id})
                .run(handler)
            const uploads = await request
                .route('GET /uploads')
                .run(handler)
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
            const uploadResponse = await createUpload()
            await uploadImage(uploadResponse)
            const imageResponse = await request
                .route('POST /upload/{id}', {id: uploadResponse.id})
                .run(handler)
            const upload = await request
                .route('GET /upload/{id}', {id: imageResponse.id})
                .run(handler)
            expect(upload).toEqual({
                contentType: 'image/png',
                type: 'profile_pic',
                id: 'profile_pic.png',
                url: `https://${Bucket}.s3.eu-south-1.amazonaws.com/public/${sub}/profile_pic.png`,
                image: {width: 100, height: 100}
            })
        })
    })

    async function createUpload() {
        return await request
            .route('POST /uploads')
            .jsonBody({type: "profile_pic"})
            .lambdaAuth({profile: {sub}})
            .run(handler)
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
