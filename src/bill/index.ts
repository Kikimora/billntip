import _ from "lodash";
import {ConditionalCheckFailedException, DynamoDB} from "@aws-sdk/client-dynamodb";
import {
    JsonRequest,
    LambdaAuthorizedRequest,
    Middleware,
    pipeline,
    LambdaRequest,
    accessDeniedError,
    TracedEvent, internalServerError
} from '@app/lambda'
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
import {die, toCamel} from "@app/util";
import UserRepo, {invalidAliasException} from "../users/user";
import {__init} from "@src/users";
import {userPoolClientDetails, userPoolDetails} from "@src/cognito";

const UserPoolId = process.env.USER_POOL_ID ?? die("USER_POOL_ID env variable is required")

const dynamo = new DynamoDB()
const cognito = new CognitoIdentityProvider()

configure({triggers: {request: true}})

export const handler = pipeline()
    .handleErrors()
    .traceRequest()
    .requireLambdaAuth<SessionContext>()
    .withRoutes(Routes)
    .parseJsonBody()
    .do(async function (this: Middleware, e: TracedEvent, ctx: any) {
        const response = await this.next(e, ctx)
        //cleanup AWS noise
        delete response?.$metadata
        return toCamel(response)
    })
    .do(async function (this: Middleware, req: TracedEvent & LambdaAuthorizedRequest<SessionContext>, ctx: Context) {
        const user = req.user.profile
        const groups = user['cognito:groups']
        const isBusiness = _.includes(groups, 'business');
        const isAdmin = _.includes(groups, 'admin');
        req.tracer.info("Groups", {groups, isBusiness, isAdmin})
        if (isBusiness || isAdmin) {
            return await this.next(req as any, ctx)
        }
        throw accessDeniedError()
    })
    .done(async function (req) {
        switch (req.routeKey) {
            case 'GET /bill/invites': {
                return {"operation": "GetInvites"}
            }
            case 'POST /bill/invite': {
                const {body} = req.parse()
                const userRepo = new UserRepo(req, dynamo)

                const response = await cognito.adminCreateUser({
                    UserPoolId,
                    Username: body.email,
                    MessageAction: body.resend ? "RESEND" : undefined,
                    UserAttributes: [{
                        Name: 'email',
                        Value: body.email
                    }, {
                        Name: 'email_verified',
                        Value: 'true'
                    }]
                })

                const userId = response.User?.Username
                if (userId === undefined) {
                    throw internalServerError("Cognito did't create user id")
                        .withContext("POST /bill/invite", {
                            response
                        })
                }

                await userRepo.create(userId, "trusted", [{name: "email", value: body.email}])

                return response
            }
            case 'GET /bill/invite/{id}': {
                const {path} = req.parse()
                return {id: path.id}
            }
            case 'DELETE /bill/invite/{id}': {
                const {path} = req.parse()
                return {id: path.id}
            }
            case "PUT /bill/invite/{id}": {
                return {id: "!!!!"}
            }
        }
    })

async function getOrCreateUser(email: string) {
    createUser: try {
        const {User: user} = await cognito.adminCreateUser({
            UserPoolId: UserPoolId,
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
                UserPoolId: UserPoolId,
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
