
// Create an AWS resource (S3 Bucket)
import * as aws from "@pulumi/aws";

export const bucket = new aws.s3.Bucket("bucket");
