import * as path from "upath";
import * as pulumi from "@pulumi/pulumi"
import {CustomResourceOptions} from "@pulumi/pulumi"
import * as aws from "@pulumi/aws";
import {FunctionArgs} from "@pulumi/aws/lambda";
import {dataTable, sessionsTable} from "./data";
import {LambdaHandler, makeLambdaNamer, makeResourceId, unpack} from "../billntip-lambdas";
import {LambdaBuilder} from "../lambdas";
import _ from "../lodash";

export type LambdaEnvironment = pulumi.Input<{ [key: string]: pulumi.Input<string> }>

export const makeLambdaName = makeLambdaNamer(pulumi.getStack())

const builder = new LambdaBuilder({
    outDir: "../out",
    esBuildOptions: {
        absWorkingDir: path.resolve("../src"),
        tsconfig: "../tsconfig.json",
    },
    lambdaName: makeLambdaName
})

/**
 * Create a well known Lambda function identified by {@link LambdaHandler}.
 */
export function createLambda(lambdaHandler: LambdaHandler,
                             env: LambdaEnvironment,
                             args: Partial<FunctionArgs>,
                             opts?: CustomResourceOptions): aws.lambda.Function {
    const {module, handler} = unpack(lambdaHandler)
    const id = makeResourceId(lambdaHandler)
    const settings = handlerSettings[lambdaHandler];
    const role = createLambdaRole(`${id}-role`, settings);
    args = _.defaults(args, defaultLambdaArguments);

    return new aws.lambda.Function(`${id}-fn`, {
        ...args,
        environment: createLambdaEnvironment(env, settings),
        name: makeLambdaName(lambdaHandler),
        code: new pulumi.asset.FileArchive(builder.bundle(module)),
        handler: `index.${handler}`,
        role: role.arn,
    }, opts);
}

type HandlerSettings = {
    permissions: aws.types.input.iam.RoleInlinePolicy[],
    env: { [key: string]: pulumi.Output<string> }
}

const handlerSettings: { [key in LambdaHandler]: HandlerSettings } = {
    [LambdaHandler.ApiHandler]: {
        permissions: [makeTableAccess(dataTable)],
        env: {}
    },
    [LambdaHandler.AuthCookieHandler]: {
        permissions: [makeTableAccess(sessionsTable)],
        env: {sessionTable: sessionsTable.name,}
    },
    [LambdaHandler.AuthCodeHandler]: {
        permissions: [makeTableAccess(sessionsTable)],
        env: {}
    },
    [LambdaHandler.UsersPreSignupHandler]: {
        permissions: [],
        env: {}
    }
}

function makeTableAccess(table: aws.dynamodb.Table) {
    return table.arn.apply(arn => (
        {
            name: 'DynamoDbAccess',
            policy: JSON.stringify({
                Version: "2012-10-17",
                Statement: [{
                    Effect: "Allow",
                    Action: [
                        "dynamodb:GetItem",
                        "dynamodb:DeleteItem",
                        "dynamodb:PutItem",
                        "dynamodb:Scan",
                        "dynamodb:Query",
                        "dynamodb:UpdateItem",
                        "dynamodb:DescribeTable",
                    ],
                    Resource: arn,
                }],
            })
        }
    ))
}


function createLambdaRole(name: string, settings: HandlerSettings) {
    return new aws.iam.Role(name, {
        assumeRolePolicy: {
            Version: "2012-10-17",
            Statement: [{
                Action: "sts:AssumeRole",
                Effect: "Allow",
                Principal: {
                    Service: "lambda.amazonaws.com",
                },
            }],
        },
        inlinePolicies: settings.permissions,
        managedPolicyArns: [
            'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
        ]
    });
}

function createLambdaEnvironment(env: LambdaEnvironment, settings: HandlerSettings) {
    return {
        variables: {
            ...env,
            ...settings.env
        }
    };
}

const nodejs20xRuntime = "nodejs20.x" as aws.lambda.Runtime;
const defaultLambdaArguments = {
    runtime: nodejs20xRuntime
}