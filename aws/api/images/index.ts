import * as pulumi from "@pulumi/pulumi";
import {newPolicy} from "@aws/util";
import authorizer from "@aws/api/authorizer";
import {s3} from "@aws/index";
import Paths from "@src/images/paths";

const images = authorizer.newAuthLambda({module: "images", handler: "handler"})
    .args({
        environment: {
            variables: {
                BUCKET: s3.bucket.id,
            }
        }
    })
    .inlinePolicy(newPolicy()
        .allow(
            "s3:PutObject",
            "s3:GetObject",
            "s3:DeleteObject"
        )
        .on(
            pulumi.interpolate`${s3.bucket.arn}/public/*`,
            pulumi.interpolate`${s3.bucket.arn}/uploads/*`,
        )
        .buildRoleInlinePolicy('S3Access'))
    .build()

export default authorizer.newAuthorizedIntegration(images)
    .addRoutes(Paths)
    .done()