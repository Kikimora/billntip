import {RequestBuilder, resources} from "@app/test/util";
import {generateImage} from 'js-image-generator'
import fs from "fs";
import cognito, {TestUser} from "@app/test/cognito"
import {TokenEndpointResponse} from "@src/authorizer/oidc_tokens";

const {
    s3: {bucket: {id: Bucket}},
    cognito: {
        userPool: {id: userPoolId},
        clients: {api: {id: userPoolClientId}}
    }
} = resources()
process.env.BUCKET = Bucket
process.env.AWS_REGION = "eu-south-1"
process.env.USER_POOL_ID = userPoolId
//Must be after process.env modifications
import {CreateUploadResponse, handler} from "@src/images/index";

let user!: TestUser
let tokens!: TokenEndpointResponse
let sub!: string

beforeAll(async () => {
    const x = await cognito.init(userPoolId, userPoolClientId)
    const y = await x.loadTestGroup()
    user = await y.createUniqueUser()
    tokens = await user.login()
    const usr = await user.data()
    sub = usr.UserAttributes!.find(x => x.Name === "sub")!.Value!
})

afterAll(async () => {
    await user?.delete()
})

let request!: RequestBuilder
beforeEach(() => {
    request = new RequestBuilder({functionName: "images", functionVersion: "Test"})
})

describe("POST /uploads", () => {
    it("return an upload URL with parameters", async () => {
        request.route('POST /uploads').json({type: "profile_pic"}).lambdaAuth({profile: {sub}})
        const response = await handler(request.event, request.context)
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
        request.route('POST /uploads').json({type: "profile_pic"}).lambdaAuth({profile: {sub}})
        const uploadResponse: CreateUploadResponse = await handler(request.event, request.context)
        await uploadImage(uploadResponse)
        request.route('POST /upload/{id}', {id: uploadResponse.id})
        const imageResponse = await handler(request.event, request.context)
        const url = `https://${Bucket}.s3.eu-south-1.amazonaws.com/public/${sub}/profile_pic.png`;
        expect(imageResponse).toEqual({
            type: 'profile_pic',
            id: uploadResponse.id,
            contentType: 'image/png',
            image: {
                url: url,
                height: 100,
                width: 100
            }
        })
    })

    it("updates picture attribute", async () => {
        request.route('POST /uploads').json({type: "profile_pic"}).lambdaAuth({profile: {sub}})
        const uploadResponse: CreateUploadResponse = await handler(request.event, request.context)
        await uploadImage(uploadResponse)
        request.route('POST /upload/{id}', {id: uploadResponse.id})
        await handler(request.event, request.context)
        const url = `https://${Bucket}.s3.eu-south-1.amazonaws.com/public/${sub}/profile_pic.png`;

        const {UserAttributes: attrs} = await cognito.client.getUser({
            AccessToken: tokens.access_token
        })
        expect(attrs).toEqual(expect.arrayContaining([{Name: "picture", Value: url}]))
    })
})

async function uploadImage(response: CreateUploadResponse) {
    const imageBuffer = await new Promise<Buffer>(function (resolve, reject) {
        generateImage(400, 400, 0.5, function (err, img) {
            if (err) return reject(err)
            fs.writeFileSync("output.jpeg", img.data)
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
