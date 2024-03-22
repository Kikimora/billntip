import _ from "lodash";
import {ConditionalCheckFailedException, DynamoDB} from "@aws-sdk/client-dynamodb";
import {JsonRequest, LambdaAuthorizedRequest, Middleware, pipeline, Request} from '@app/lambda'
import {configure} from "@app/diagnostics";
import {getCommand, putCommand, queryCommand} from "@app/dynamodb";
import {Employees, ManagersIndex} from "@src/data";
import {
    CognitoIdentityProvider,
    ListUsersCommand
} from "@aws-sdk/client-cognito-identity-provider";
import {SessionContext} from "@src/authorizer/session";
import {Context} from "aws-lambda";
import {unmarshall} from "@aws-sdk/util-dynamodb";
import Routes from "./routes";

const UserPool = process.env.USER_POOL ?? _.throw("USER_POOL env variable is required")

const dynamo = new DynamoDB()
const cognito = new CognitoIdentityProvider()

configure({triggers: {request: true}})

interface BusinessRequest {
    business?: string
}

interface InviteRequest extends BusinessRequest {
    email: string
}

export const invite = pipeline()
    .traceRequest()
    .withRoutes(Routes)
    .requireLambdaAuth<SessionContext>()
    .parseJsonBody()
    .do(async function (this: Middleware, req: JsonRequest & LambdaAuthorizedRequest<SessionContext>, ctx: Context) {
        const business = 'business' in req && String(req['business']) || undefined

        const businesses = await dynamo.send(queryCommand(ManagersIndex, {
            indexName: "business_users",
            values: {
                userId: `u_${req.requestContext.authorizer.lambda.id_token.sub}`,
            },
            keyCondition: ({key, val}) => `${key.uid} = ${val.userId}`
        }))

        let businessRecord
        if (business === undefined) {
            if (businesses.Count === 1)
                businessRecord = businesses.Items?.[0]
        } else {
            businessRecord = businesses.Items?.find(x => x['pk'].S === business)
        }

        if (businessRecord === undefined) {
            throw new Error()
        }

        const x = unmarshall(businessRecord)

        return await this.next(req as any, ctx)
    })
    .done(async function (e) {
        switch (e.routeKey) {
            case 'GET /bill/invites': {
                return {"operation": "GetInvites"}
            }
            case 'POST /bill/invite': {
                //validate JSON using Zod?
                //how to map user to business?
                //
                // const {email, business} = e.json as InviteRequest
                // const userId = await getOrCreateUser(email)
                //
                // const businesses = await dynamo.send(queryCommand(ManagersIndex, {
                //     values: {
                //         userId: `u_${e.requestContext.authorizer.lambda.id_token.sub}`,
                //     },
                //     keyCondition: ({key, val}) => `${key.uid} = ${val.userId}`
                // }))
                // if (business === undefined && businesses.Count === 1) {
                //
                // } else if ()
                //
                //     //either no business in request and one business in db
                //     //OR business in request and matching business in DB
                //
                //     businesses.Items?.find(x => x['pk'] === business)
                //
                // await dynamo.send(putCommand(Employees, {
                //     key: {
                //         pk: `b_12`,
                //         sk: `emp_${userId}`
                //     },
                //     item: {
                //         invited_at: Date.now(),
                //         team: "Unknown",
                //         uid: userId,
                //         accepted_at: 0
                //     }
                // }))

                return {"operation": "CreateInvite"}
            }
            case 'GET /bill/invite/{id}': {
                const {id} = e.pathParameters ?? _.throw("'id' required")
                return {id}
            }
            case 'DELETE /bill/invite/{id}': {
                const {id} = e.pathParameters ?? _.throw("'id' required")
                return {id}
            }
        }
    })

async function getOrCreateUser(email: string) {
    createUser: try {
        const {User: user} = await cognito.adminCreateUser({
            UserPoolId: UserPool,
            MessageAction: 'RESEND',
            Username: email,
            UserAttributes: [
                {Name: "email", Value: email},
                {Name: "email_verified", Value: "true"},
            ],
            //This is data for an invite email generator
            ClientMetadata: {
                "invited_by": "BUSINESS NAME",
                "invited_into": "TEAM NAME"
            }
        })

        if (user?.Username === undefined) break createUser

        return user.Username

    } catch (e: any) {
        if ('name' in e && e.name == 'UsernameExistsException') {
            const command = new ListUsersCommand({
                UserPoolId: UserPool,
                AttributesToGet: ['email', 'sub'],
                Filter: `email = "${email}"`,
                Limit: 1
            });
            const result = await cognito.send(command);
            const user = result.Users?.[0]
            if (user?.Username === undefined) break createUser
            return user.Username
        }
        throw e
    }

    throw new Error("Cannot get or create user")
}
