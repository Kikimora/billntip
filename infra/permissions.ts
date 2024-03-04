import * as aws from "@pulumi/aws";
import {makeResourceId} from "../billntip-lambdas";
import * as pulumi from "@pulumi/pulumi";
import {Lambda} from "./lambda";
import {diagnosticsParameterArn} from "./api/urls";

export function givePermission(lambda: Lambda,
                               caller: aws.apigatewayv2.Api | aws.cognito.UserPool) {
    const id = makeResourceId(lambda.handler)

    if (caller instanceof aws.apigatewayv2.Api) {
        return new aws.lambda.Permission(`${id}-permissions`, {
            action: "lambda:invokeFunction",
            function: lambda.function.arn,
            principal: "apigateway.amazonaws.com",
            sourceArn: pulumi.interpolate`${caller.executionArn}/*/*`,
        });
    } else {
        return new aws.lambda.Permission(`${id}-permissions`, {
            action: "lambda:invokeFunction",
            function: lambda.function.arn,
            principal: "cognito-idp.amazonaws.com",
            sourceArn: caller.arn,
        })
    }
}

export function makeTableAccess(table: aws.dynamodb.Table) {
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

export function makeUserPoolAccess(userPool: aws.cognito.UserPool) {
    return userPool.arn.apply(arn => (
        {
            name: 'UserPoolAccess',
            policy: JSON.stringify({
                Version: "2012-10-17",
                Statement: [{
                    Effect: "Allow",
                    Action: [
                        "cognito-idp:DescribeUserPoolClient",
                    ],
                    Resource: arn,
                }],
            })
        }
    ))
}

export function makeDiagnosticsConfigAccess() {
    return pulumi.Output.create(diagnosticsParameterArn.then(arn => ({
        name: 'DiagnosticsConfigAccess',
        policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "ssm:GetParameter",
                ],
                Resource: arn
            }],
        })
    })))
}
