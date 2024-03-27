import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {FunctionArgs} from "@pulumi/aws/lambda";
import {iam} from "@pulumi/aws/types/input";
import {Builder, LambdaSource} from "@app/lambda/builder";
import _ from '@app/util';
import {RouteMap} from "@app/lambda";
import {IntegrationArgs} from "@pulumi/aws/apigatewayv2/integration";
import {RequiredKeysOf} from "type-fest";
import {ProviderResource} from "@pulumi/pulumi";

/**
 * Details of an AWS service that wants to call a Lambda function.
 */
export interface LambdaCaller {
    principal: pulumi.Input<string>,
    sourceArn: pulumi.Input<string>
}

const makeResourceId = _.memoize(function ({module, handler}: LambdaSource) {
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
    grantInvoke(client: LambdaCaller): LambdaBuilder

    /**
     * Build lambda function
     */
    build(): LambdaFunction
}

type AwsResource = { arn: pulumi.Output<string> }

export function grantInvoke(lambda: LambdaFunction, client: LambdaCaller): aws.lambda.Permission {
    const {id, arn} = lambda
    return new aws.lambda.Permission(`${id}-permissions`, {
        action: "lambda:invokeFunction",
        function: arn,
        principal: client.principal,
        sourceArn: client.sourceArn,
    });
}

interface NewLambdaModule {
    (decl: LambdaSource): LambdaBuilder

    defaults: Partial<FunctionArgs>

    builder?: Builder | (() => Builder)

    role(name: string, ...settings: iam.RoleInlinePolicy[]): aws.iam.Role
}

const newLambdaModule = function (src: LambdaSource) {
    let _opts: pulumi.CustomResourceOptions
    let _args: Partial<FunctionArgs> = {}
    let _policies: RolePolicy[] = []
    let _role: aws.iam.Role
    let _client: LambdaCaller

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
        grantInvoke(client: LambdaCaller) {
            _client = client
            return this
        },

        build(builder?: Builder): LambdaFunction {
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

            const id = makeResourceId(src)
            const role = _role !== undefined ? _role : newLambdaRole(`${id}-role`, ..._policies);
            const defaults = newLambda.defaults ?? {}
            const args = _.merge({}, _args, defaults)
            const handler = `index.${src.handler}`;
            const lambdaFunction = new aws.lambda.Function(`${id}-fn`, {
                    ...args,
                    name: builder.lambdaName(src),
                    code: new pulumi.asset.FileArchive(builder.bundle(src.module, "ts")),
                    handler,
                    role: role.arn
                },
                //Ignore changes in code otherwise Pulumi detects changes every update.
                //Use `npm run update` script to update Lambdas e.g. `npm run update --handlers 'authorizer.*'`
                {ignoreChanges: ['code'], ..._opts})

            const lambda = {
                id,
                src,
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

export type LambdaFunction = {
    src: LambdaSource,
    handler: string
    id: string
    arn: pulumi.Output<string>
    invokeArn: pulumi.Output<string>
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


interface ApiRoute extends Omit<aws.apigatewayv2.RouteState, "routeKey"> {
    routeKey: string
}

export interface ApiGateway {
    /**
     * Logical API Gateway name
     */
    name: string,
    /**
     * API Gateway identifier (aka apiId)
     */
    id: pulumi.Output<string>,
}

export type Resource<T extends Record<string, any>> = Omit<{ [key in RequiredKeysOf<T>]: T['key'] }, 'getProvider'>
export type RouteResource = aws.apigatewayv2.Route & { src: string, lambdaArn: pulumi.Output<string> }

export function newApiGwIntegration(gw: ApiGateway, lambda: LambdaFunction, args?: Partial<IntegrationArgs>) {
    const integration = new aws.apigatewayv2.Integration(`${lambda.id}-integration`, {
        integrationType: "AWS_PROXY", // AWS_PROXY for Lambda function integration
        ...args,
        apiId: gw.id,
        integrationUri: lambda.arn,
        payloadFormatVersion: "2.0",
    });

    let _default: Partial<ApiRoute>
    let routes: RouteResource[] = []

    return {

        defaults(route: Partial<ApiRoute>) {
            _default = route
            return this
        },

        addRoutes(routes: RouteMap) {
            for (let [k, v] of Object.entries(routes)) {
                this.addRoute({
                    routeKey: k,
                    operationName: v.operationId,
                })
            }
            return this
        },

        addRoute(route: ApiRoute) {
            const {routeKey} = route
            const name = `${gw.name}-${makeName(routeKey)}`

            const routeResource = new aws.apigatewayv2.Route(name, {
                ..._default,
                ...route,
                apiId: gw.id,
                target: pulumi.interpolate`integrations/${integration.id}`
            }) as any;
            routeResource.src = `${lambda.src.module}/${lambda.src.handler}`
            routeResource.lambdaArn = lambda.arn
            routes.push(routeResource)

            return this
        },

        done() {
            return {
                integration,
                routes
            }
        }
    }
}

/**
 * Convert route key into logical resource name
 * @param routeKey - API Gateway route key
 * @example
 * makeName("GET /bill/invite/{id}") //get-bill-invite-id
 * makeName("$default") //default
 */
function makeName(routeKey: string) {
    if (routeKey === "$default") {
        return "default"
    }
    const [method, path, ...rest] = routeKey.split(' ')
    if (rest.length > 0) throw new Error(`Invalid routeKey ${routeKey}`)
    return `${method.toLowerCase()}-${_.trim(path, '/$').replaceAll('/', '-').replaceAll(/[}{]/g, '')}`
}