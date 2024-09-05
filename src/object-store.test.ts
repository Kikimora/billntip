import {S3Object} from "@src/object-store";

const bucket = "bucket-56f55cc"

describe("head", () => {
    it("optionally returns undefined if object not found", async () => {
        const obj = new S3Object(bucket, "does not exists")
        const metadata = await obj.head().returnNothingIfNotFound()
        expect(metadata).toBeUndefined()
    })
    it("throws if object not found", async () => {
        const obj = new S3Object(bucket, "does not exists")
        const metadata = obj.head()
        await expect(metadata).rejects.toMatchObject({
            statusCode: "404"
        })
    })
})