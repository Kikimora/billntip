import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {FunctionArgs} from "@pulumi/aws/lambda";
import {iam} from "@pulumi/aws/types/input";
import {Builder, Lambda as LambdaDeclaration} from "@app/lambda/builder";
import _ from '@app/util';

/**
 * Details of an AWS service that wants to call a Lambda function.
 */
interface LambdaClient {
    principal: pulumi.Input<string>,
    sourceArn: pulumi.Input<string>
}

const makeResourceId = _.memoize(function ({module, handler}: LambdaDeclaration) {
    return `${module}-${handler}`
})

/**
 * Builds IAM policy statement.
 */
interface StatementBuilder {
    /**
     * Adds resources to the statement and completes it
     * @param resources - resource ARNs
     */
    on(...resources: AwsResource[]): PolicyBuilder
}

interface RolePolicy {
    /**
     * Name of the role policy.
     */
    name: pulumi.Input<string>;
    /**
     * Policy document as a JSON formatted string.
     */
    policy: pulumi.Input<string>;
}

/**
 * IAM role policy builder.
 */
interface PolicyBuilder {
    /**
     * Starts 'Effect: "Allow"' statement. See also {@link StatementBuilder} and {@link StatementBuilder.on}.
     * @param actions - allowed actions
     */
    allow(...actions: string[]): StatementBuilder

    /**
     * Starts 'Effect: "Deny"' statement. See also {@link StatementBuilder} and {@link StatementBuilder.on}.
     * @param actions - denied actions
     */
    deny(...actions: string[]): StatementBuilder,

    /**
     * Builds inline policy.
     */
    build(): RolePolicy
}

/**
 * AWS Lambda function builder.
 */
interface LambdaBuilder {
    /**
     * Specify Lambda custom resource options.
     * @param options - custom resource options
     */
    options(options: pulumi.CustomResourceOptions): LambdaBuilder,

    /**
     * Specify AWS Lambda function arguments. Can be called multiple times, provided arguments deep merged together with
     * {@link _.merge}.
     * @param args - function arguments
     */
    args(args: Partial<FunctionArgs>): LambdaBuilder,

    /**
     * Specify
     * @param permissions
     */
    inlinePolicy(...permissions: RolePolicy[]): LambdaBuilder,

    /**
     * Set lambda function exeuction role.
     * @param role - execution role
     */
    role(role: aws.iam.Role): LambdaBuilder,

    /**
     * Grant rights to invoke the function
     * @param client - grantee
     */
    grantInvoke(client: LambdaClient): LambdaBuilder

    /**
     * Build lambda function
     */
    build(): Lambda
}

type AwsResource = { arn: pulumi.Output<string> }

export function grantInvoke(lambda: Lambda, client: LambdaClient): aws.lambda.Permission {
    const {id, arn} = lambda
    return new aws.lambda.Permission(`${id}-permissions`, {
        action: "lambda:invokeFunction",
        function: arn,
        principal: client.principal,
        sourceArn: client.sourceArn,
    });
}

interface NewLambdaModule {
    (decl: LambdaDeclaration): LambdaBuilder

    defaults: Partial<FunctionArgs>

    builder?: Builder | (() => Builder)

    role(name: string, ...settings: iam.RoleInlinePolicy[]): aws.iam.Role
}

const newLambdaModule = function (decl: LambdaDeclaration) {
    let _opts: pulumi.CustomResourceOptions
    let _args: Partial<FunctionArgs> = {}
    let _policies: RolePolicy[] = []
    let _role: aws.iam.Role
    let _client: LambdaClient

    const lambdaBuilder: LambdaBuilder = {
        options(options: pulumi.CustomResourceOptions) {
            _opts = options
            return this
        },
        args(args: Partial<FunctionArgs>) {
            _args = _.merge(_args, args)
            return this
        },
        inlinePolicy(...policies: RolePolicy[]) {
            _policies.push(...policies)
            return this
        },
        role(role: aws.iam.Role) {
            _role = role
            return this
        },
        grantInvoke(client: LambdaClient) {
            _client = client
            return this
        },

        build(builder?: Builder): Lambda {
            if (_role !== undefined && _policies.length > 0)
                throw new Error("Either role or permissions can be specified but not both.")

            if (builder === undefined) {
                const provider = newLambdaModule.builder as any
                if (typeof provider === "function") {
                    builder = provider()
                } else {
                    builder = provider
                }
            }

            if (builder == null) {
                throw new Error("")
            }

            const id = makeResourceId(decl)
            const role = _role !== undefined ? _role : newLambdaRole(`${id}-role`, ..._policies);
            const defaults = newLambda.defaults ?? {}
            const args = _.merge({}, _args, defaults)
            const handler = `index.${decl.handler}`;
            const lambdaFunction = new aws.lambda.Function(`${id}-fn`, {
                    ...args,
                    name: builder.lambdaName(decl),
                    code: new pulumi.asset.FileArchive(builder.bundle(decl.module, "ts")),
                    handler,
                    role: role.arn
                },
                //Ignore changes in code otherwise Pulumi detects changes every update.
                //Use `npm run update` script to update Lambdas e.g. `npm run update --handlers 'authorizer.*'`
                {ignoreChanges: ['code'], ..._opts})

            const lambda = {
                id,
                handler,
                arn: lambdaFunction.arn,
                invokeArn: lambdaFunction.invokeArn,
            }
            if (_client !== undefined) {
                grantInvoke(lambda, _client)
            }
            return lambda
        }
    }
    return lambdaBuilder
}
newLambdaModule.defaults = {} as Partial<FunctionArgs>
newLambdaModule.role = newLambdaRole
newLambdaModule.builder = undefined
export const newLambda: NewLambdaModule = newLambdaModule

export function newPolicy(name: string): PolicyBuilder {
    const statements: any[] = []

    function statementBuilder(effect: string, actions: string[]): StatementBuilder {
        return {
            on(...resources: { arn: pulumi.Input<string> }[]) {
                const arns = resources.map(x => x.arn);
                statements.push(pulumi.all(arns).apply(resources => {
                    return {
                        Effect: effect,
                        Action: actions,
                        Resource: resources
                    }
                }))
                return policyBuilder
            }
        }
    }

    const policyBuilder: PolicyBuilder = {
        allow(...actions: string[]) {
            return statementBuilder("Allow", actions)
        },
        deny(...actions: string[]) {
            return statementBuilder("Deny", actions)
        },
        build() {
            return {
                name,
                policy: pulumi.all(statements).apply(statements =>
                    JSON.stringify({
                        Version: "2012-10-17",
                        Statement: statements,
                    })
                )
            }
        }
    }

    return policyBuilder
}

export type Lambda = {
    handler: string
    id: string
    arn: pulumi.Input<string>
    invokeArn: pulumi.Input<string>
}

export function newLambdaRole(name: string, ...settings: iam.RoleInlinePolicy[]) {
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
            'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
        ]
    });
}
