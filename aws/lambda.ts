import * as path from "upath";
import * as pulumi from "@pulumi/pulumi"
import * as aws from "@pulumi/aws";
import {FunctionArgs} from "@pulumi/aws/lambda";
import {iam} from "@pulumi/aws/types/input";
import {LambdaHandler, makeLambdaNamer, makeResourceId, unpack} from "../billntip-lambdas";
import {LambdaBuilder} from "../lambdas";
import _ from "../util";
import RoleInlinePolicy = iam.RoleInlinePolicy;

export {LambdaHandler}
export type LambdaEnvironment = Record<string, string | pulumi.Output<string>>

export const makeLambdaName = makeLambdaNamer(pulumi.getStack())

const builder = new LambdaBuilder({
    outDir: "../out",
    esBuildOptions: {
        absWorkingDir: path.resolve("../src"),
        tsconfig: "../tsconfig.json",
        sourcemap: true
    },
    lambdaName: makeLambdaName
})

export type Lambda = {
    function: aws.lambda.Function,
    handler: LambdaHandler
}

/**
 * Create a well known Lambda function identified by {@link LambdaHandler}.
 */
export function createLambda(lambdaHandler: LambdaHandler,
                             env: LambdaEnvironment,
                             args: Partial<FunctionArgs>,
                             permissions?: RoleInlinePolicy[],
                             opts?: pulumi.CustomResourceOptions): Lambda {
    const {module, handler} = unpack(lambdaHandler)
    const id = makeResourceId(lambdaHandler)
    permissions = permissions ?? []
    //permissions.push(makeDiagnosticsConfigAccess())
    const role = createLambdaRole(`${id}-role`, permissions);
    args = _.defaults(args, defaultLambdaArguments);

    const lambda = new aws.lambda.Function(`${id}-fn`, {
        ...args,
        environment: createLambdaEnvironment(env),
        name: makeLambdaName(lambdaHandler),
        code: new pulumi.asset.FileArchive(builder.bundle(module, "ts")),
        handler: `index.${handler}`,
        role: role.arn,
    }, opts);

    return {function: lambda, handler: lambdaHandler}
}

function createLambdaRole(name: string, settings: iam.RoleInlinePolicy[] | undefined) {
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
        inlinePolicies: settings,
        managedPolicyArns: [
            'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ]
    });
}

function createLambdaEnvironment(env: LambdaEnvironment) {
    return {
        variables: {
            ...env,
            NODE_OPTIONS: '--enable-source-maps'
        }
    };
}

const nodejs20xRuntime = "nodejs20.x" as aws.lambda.Runtime;
const defaultLambdaArguments = {
    runtime: nodejs20xRuntime,
    architectures: ["arm64"],
    loggingConfig: {
        logFormat: "JSON",
        systemLogLevel: pulumi.getStack() == "dev" ? "DEBUG" : "WARN"
    }
}

interface LambdaCaller {
    principal: pulumi.Input<string>,
    sourceArn: pulumi.Input<string>
}

export function givePermission(lambda: Lambda, caller: LambdaCaller) {
    const id = makeResourceId(lambda.handler)
    return new aws.lambda.Permission(`${id}-permissions`, {
        action: "lambda:invokeFunction",
        function: lambda.function.arn,
        principal: caller.principal,
        sourceArn: caller.sourceArn,
    });
}

export function makeDynamoDbAccess(...tables: pulumi.Input<string>[]) {
    return pulumi.all(tables).apply(arns => ({
            name: `DynamoDbAccess`,
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
                    Resource: arns,
                }],
            })
        }
    ))
}

export function makeUserPoolAccess(...userPools: pulumi.Input<string>[]) {
    return pulumi.all(userPools).apply(arns => (
        {
            name: 'UserPoolAccess',
            policy: JSON.stringify({
                Version: "2012-10-17",
                Statement: [{
                    Effect: "Allow",
                    Action: [
                        "cognito-idp:DescribeUserPoolClient",
                    ],
                    Resource: arns,
                }],
            })
        }
    ))
}
