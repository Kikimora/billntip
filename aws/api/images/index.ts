import * as pulumi from "@pulumi/pulumi";
import {newPolicy} from "@aws/util";
import authorizer from "@aws/api/authorizer";
import {bucket} from "@aws/s3";
import Paths from "@src/images/paths";
import {Lambdas} from "@aws/lambdas";

const images = authorizer.newAuthLambda(Lambdas['images.handler'])
    .args({
        environment: {
            variables: {
                BUCKET: bucket.id,
            }
        }
    })
    .inlinePolicy(newPolicy()
        .allow(
            "s3:PutObject",
            "s3:GetObject",
            "s3:DeleteObject",
            "s3:ListBucket"
        )
        .on(
            pulumi.interpolate`${bucket.arn}`,
            pulumi.interpolate`${bucket.arn}/public/*`,
            pulumi.interpolate`${bucket.arn}/uploads/*`,
            pulumi.interpolate`${bucket.arn}/tmp/*`,
        )
        .buildRoleInlinePolicy('S3Access'))
    .build()

export default authorizer.newAuthorizedIntegration(images)
    .addRoutes(Paths)
    .done()