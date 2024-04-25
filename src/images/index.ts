import {Static} from "@sinclair/typebox";
import {pipeline} from "@app/lambda";
import {SessionContext} from "@src/authorizer/session";
import Paths, {CreateEmptyImageResponse} from "./paths";
import uploads from "./uploads"
import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {die} from "@app/util";

const UserPoolId = process.env.USER_POOL_ID ?? die("USER_POOL_ID required")

export type CreateUploadResponse = Static<typeof CreateEmptyImageResponse>

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .requireLambdaAuth<SessionContext>()
    .parseJsonBody()
    .withRoutes(Paths)
    .done(async function (req) {
        //This could be user or organisation
        const owner = req.user.profile.sub

        switch (req.routeKey) {
            case 'POST /uploads': {
                const {body: {type}} = req.parse()
                const {post, expires, id} = await uploads.prepare(owner, type)
                return {
                    type: "profile_pic",
                    id: id,
                    uploadUrl: post.url,
                    uploadFields: post.fields,
                    expires: new Date(Date.now() + expires * 1000)
                } satisfies Static<typeof req.route.success>
            }
            case 'POST /upload/{id}': {
                const {path: {id}} = req.parse()
                const {uploadObject, type} = await uploads.read(owner, id)
                //contentType and output should depend on type, e.g. image/png for profile pic, image/jpeg for ads, etc
                const {contentType, buffer, width, height} = await uploads.process(type, uploadObject)
                const s3ImageKey = await uploads.save(buffer, owner, type)
                const url = `https://${uploads.Bucket}.s3.${uploads.Region}.amazonaws.com/${s3ImageKey}`;
                if (type === 'profile_pic') {
                    const cognito = new CognitoIdentityProvider()
                    await cognito.adminUpdateUserAttributes({
                        UserPoolId: UserPoolId,
                        Username: req.user.profile.sub,
                        UserAttributes: [
                            {Name: "picture", Value: url}
                        ]
                    })
                }
                //invalidate CloudFront cache ???
                return {
                    type,
                    id: id,
                    contentType: contentType,
                    image: {url, height, width},
                } satisfies Static<typeof req.route.success>
            }
            case 'DELETE /upload/{id}': {
                const {path: {id}} = req.parse()
                await uploads.remove(owner, id)
                return {
                    statusCode: 200
                }
            }
        }
    })
