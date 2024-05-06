import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {loadAndBundleSpec} from "redoc"
import {newPolicy} from "@aws/util";
import makeOpenAPISpec from "../doc/main";
import fs from "fs";

const s3Bucket = new aws.s3.Bucket("bucket", {
    corsRules: [{
        allowedHeaders: ["*"],
        allowedOrigins: ["*"],
        allowedMethods: ["GET", "POST"]
    }],
    lifecycleRules: [{
        enabled: true,
        prefix: 'uploads/',
        expiration: {
            days: 1,
            expiredObjectDeleteMarker: true
        },
        abortIncompleteMultipartUploadDays: 1
    }],
}, {retainOnDelete: true});

const accessBlock = new aws.s3.BucketPublicAccessBlock("bucket-access-block", {
    bucket: s3Bucket.id,
    blockPublicAcls: false,
    blockPublicPolicy: false,
    restrictPublicBuckets: false,
    ignorePublicAcls: false
})

const policy = new aws.s3.BucketPolicy("bucket-public-access", {
    bucket: s3Bucket.id,
    policy: newPolicy()
        .allow("s3:GetObject")
        .principals("*")
        .on(pulumi.interpolate`arn:aws:s3:::${s3Bucket.id}/public/*`)
        .buildPolicy()
}, {dependsOn: [s3Bucket]})

export const bucket = {
    id: s3Bucket.id,
    arn: s3Bucket.arn,
    policy: policy.policy,
}

const spec = loadAndBundleSpec(makeOpenAPISpec())
const openApi = "public/billntip.json";
new aws.s3.BucketObject("openapi-spec", {
    bucket: s3Bucket,
    key: openApi,
    source: new pulumi.asset.StringAsset(spec.then(JSON.stringify)),
    contentType: "application/json"
}, {dependsOn: [accessBlock]})

async function makeOpenAPIHtml() {
    const buffer = await fs.promises.readFile("../doc/openapi.html")
    const html = buffer.toString('utf8')
    return new pulumi.asset.StringAsset(html.replace('{{URL}}', `/${openApi}`))
}

new aws.s3.BucketObject("openapi-html", {
    bucket: s3Bucket,
    key: "public/openapi.html",
    source: makeOpenAPIHtml(),
    contentType: "text/html"
}, {dependsOn: [accessBlock]})

// const originAccessIdentity = new aws.cloudfront.OriginAccessIdentity("cdn-s3-access", {
//     comment: "Origin Access Identity for my CloudFront distribution",
// });
//
// new aws.s3.BucketPolicy("s3-public-access-policy", {
//     bucket: s3Bucket.id,
//     policy: newPolicy("GetAllObjects")
//         .allow("s3:GetObject")
//         .on(`${s3Bucket.arn}/public/*`)
//         .principals({
//             type: "AWS",
//             identifiers: [originAccessIdentity.iamArn],
//         })
//         .buildPolicy()
// });
//
// const cdn = new aws.cloudfront.Distribution("cdn", {
//     enabled: true,
//     origins: [{
//         domainName: s3Bucket.bucketRegionalDomainName,
//         originId: s3Bucket.arn,
//         s3OriginConfig: {
//             originAccessIdentity: originAccessIdentity.cloudfrontAccessIdentityPath,
//         },
//     }],
//     defaultRootObject: "api/billntip.yaml",
//     defaultCacheBehavior: {
//         targetOriginId: s3Bucket.arn,
//         viewerProtocolPolicy: "redirect-to-https",
//         allowedMethods: ["GET", "HEAD", "OPTIONS"],
//         cachedMethods: ["GET", "HEAD", "OPTIONS"],
//         forwardedValues: {
//             queryString: false,
//             cookies: {forward: "none"},
//         },
//         minTtl: 0,
//         defaultTtl: 86400,
//     },
//     restrictions: {
//         geoRestriction: {
//             restrictionType: "none",
//         },
//     },
//     viewerCertificate: {
//         cloudfrontDefaultCertificate: true,
//     },
// });