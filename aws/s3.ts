import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {loadAndBundleSpec} from "redoc"
import {newPolicy} from "@aws/util";
import makeOpenAPISpec from "../doc/main";
import fs from "fs";
import {usEast1Certificate} from "./certificate"
import {configFolder, domain, tags} from "./config"

const s3Bucket = new aws.s3.Bucket("bucket", {
    lifecycleRules: [{
        enabled: true,
        prefix: 'uploads/',
        expiration: {
            days: 1,
            expiredObjectDeleteMarker: true
        },
        abortIncompleteMultipartUploadDays: 1
    }],
    tags
}, {retainOnDelete: true});

const accessBlock = new aws.s3.BucketPublicAccessBlock("bucket-access-block", {
    bucket: s3Bucket.id,
    blockPublicAcls: false,
    blockPublicPolicy: false,
    restrictPublicBuckets: false,
    ignorePublicAcls: false
})
const spec = loadAndBundleSpec(makeOpenAPISpec())
new aws.s3.BucketObject("openapi-spec", {
    bucket: s3Bucket,
    key: `public/static/openapi.json`,
    source: new pulumi.asset.StringAsset(spec.then(JSON.stringify)),
    contentType: "application/json",
    cacheControl: 's-maxage=300'
}, {dependsOn: [accessBlock]})

async function makeOpenAPIHtml() {
    const buffer = await fs.promises.readFile("../doc/openapi.html")
    const html = buffer.toString('utf8')
    return new pulumi.asset.StringAsset(html.replace('{{URL}}', `/openapi.json`))
}

new aws.s3.BucketObject("openapi-html", {
    bucket: s3Bucket,
    key: "public/static/openapi.html",
    source: makeOpenAPIHtml(),
    contentType: "text/html",
    cacheControl: 's-maxage=300'
}, {dependsOn: [accessBlock]})

const originAccessControl = new aws.cloudfront.OriginAccessControl("cdn-s3-access", {
    originAccessControlOriginType: "s3",
    signingBehavior: "always",
    signingProtocol: "sigv4",
});

const rewriteFn = new aws.cloudfront.Function("rewrite-function", {
    code: `
function handler(event) {
    const request = event.request
    const response = event.response
    const host = request.headers['host'].value.split('.')    
    const prefix = host[0]
    if (prefix === 'static') {
        request.uri = \`/\${prefix}\${request.uri}\`
    } else {
        request.uri = \`/\${prefix}/index.html\`
    } 
    return request
}
`,
    runtime: "cloudfront-js-2.0",
    comment: "Rewrite subdomain to a folder",
    publish: true,
});

const cf = new aws.cloudfront.Distribution("cdn", {
    enabled: true,
    aliases: [
        `bill.${domain}`, `tip.${domain}`, `static.${domain}`
    ],
    viewerCertificate: {
        acmCertificateArn: usEast1Certificate.arn,
        sslSupportMethod: "sni-only",
    },
    origins: [{
        domainName: s3Bucket.bucketRegionalDomainName,
        originId: s3Bucket.arn,
        originAccessControlId: originAccessControl.id,
        originPath: "/public"
    }],
    defaultRootObject: "index.html",
    defaultCacheBehavior: {
        targetOriginId: s3Bucket.arn,
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS"],
        cachedMethods: ["GET", "HEAD", "OPTIONS"],
        forwardedValues: {
            queryString: false,
            cookies: {forward: "none"},
        },
        minTtl: 300,
        maxTtl: 86400 * 30,
        defaultTtl: 86400,
        functionAssociations: [{
            eventType: "viewer-request",
            functionArn: rewriteFn.arn,
        }],
    },
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
    tags
})

new aws.s3.BucketPolicy("bucket-public-access", {
    bucket: s3Bucket.id,
    policy: newPolicy()
        .allow("s3:GetObject")
        .principals({
            Service: "cloudfront.amazonaws.com"
        })
        .condition(cf.arn.apply(arn => ({
            StringEquals: {
                "AWS:SourceArn": arn
            }
        })))
        .on(pulumi.interpolate`arn:aws:s3:::${s3Bucket.id}/public/*`)
        .buildPolicy()
}, {dependsOn: [s3Bucket]})

export const bucket = {
    id: s3Bucket.id,
    arn: s3Bucket.arn
}

export const cdn = {
    arn: cf.arn,
    aliases: cf.aliases
}

const parameter = new aws.ssm.Parameter("s3-config", {
    name: `${configFolder}/s3`,
    type: "String",
    value: pulumi.jsonStringify({
        bucket: s3Bucket.id,
    }),
})

export const config = parameter.arn