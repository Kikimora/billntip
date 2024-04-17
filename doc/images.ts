import {OpenAPIBuilder} from "@app/lambda";
import Paths from "../src/images/paths";

export default function (api: OpenAPIBuilder) {
    api.paths(Paths).spec = {
        'DELETE /upload/{id}': {
            tags: ['images']
        },
        'POST /upload/{id}': {
            tags: ['images']
        },
        'POST /uploads': {
            description: `
Creates new upload and return its parameters, use as shown below (this is Node.JS)

\`\`\`js
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
\`\`\`
            `,
            tags: ['images']
        }
    }
}
