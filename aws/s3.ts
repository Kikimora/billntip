
// Create an AWS resource (S3 Bucket)
import * as aws from "@pulumi/aws";

const s3Bucket = new aws.s3.Bucket("bucket");

export const bucket = {
    id: s3Bucket.id
}
