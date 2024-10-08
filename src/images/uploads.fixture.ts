import {clearMock, makeContextualFixture} from "@app/test";
import {S3Object, type Upload, uploadBuilder} from "@src/object-store";
import {generateImage} from "js-image-generator";

export async function uploadBuffer(upload: Upload, content: Buffer) {
    const formData = new FormData();
    Object.entries(upload.fields).forEach(([k, v]) => {
        formData.append(k, v);
    });
    formData.append("Content-Type", "image/jpeg");
    //use blob to upload data, simple call like
    //formData.append("file", imageBuffer);
    //does upload but result in a garbage bytes written to the S3 object.
    const blob = new Blob([content], {type: "image/jpeg"})
    formData.append("file", blob, 'image.jpeg');
    return await fetch(upload.url, {method: "POST", body: formData})
}


export default makeContextualFixture({
    async before({s3}: { s3: { bucket: string, tmpPrefix?: string } }) {
        async function makeUpload(key: string) {
            const upload = uploadBuilder(key, {bucket: s3.bucket, prefix: s3.tmpPrefix ?? "tmp"})
                .condition(["content-length-range", 1024, 5 * 1024 * 1024])
                .condition(["starts-with", "$Content-Type", "image/"])
                .properties({
                    'transform': 'resize',
                    'target-width': '100',
                    'target-height': '100',
                    'target-format': 'png'
                })
            return await upload.build()
        }

        const uploadFile = jest.fn(async function (response: Upload) {
            const imageBuffer = await new Promise<Buffer>(function (resolve, reject) {
                generateImage(400, 400, 0.5, function (err, img) {
                    if (err) return reject(err)
                    return resolve(img.data)
                })
            })
            const s3Response = await uploadBuffer(response, imageBuffer);
            const message = await s3Response.text();
            if (message != "") console.error(message)
            expect(s3Response.status).toEqual(204)
            //This is what you send in POST /uploads body.
            return response.fields.key
        })
        const s3Copy = jest.spyOn(S3Object.prototype, 'copy')
        const s3Put = jest.spyOn(S3Object.prototype, 'put')
        return {s3, makeUpload, uploadFile, s3Copy, s3Put}
    },
    async after({s3, uploadFile, s3Copy, s3Put}) {

        await clearMock(s3Put, async function (this: S3Object) {
            await this.delete().catch(console.log)
        })
        await clearMock(s3Copy, async function (this: S3Object, {value}) {
            if (value !== undefined) await value.delete().catch(console.log)
        })
        await clearMock(uploadFile, async function ({value: key}) {
            if (key !== undefined) {
                const obj = new S3Object(s3.bucket, key)
                await obj.delete().catch(console.log)
            }
        })
    }
})
