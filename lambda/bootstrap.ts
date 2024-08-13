import {SSM, Parameter as SSMParameter} from "@aws-sdk/client-ssm";
import {Static, TSchema, Type, TypeGuard} from "@sinclair/typebox";
import {Value} from "@sinclair/typebox/value";
import {cache} from "@app/util";
import {internalError} from "@app/lambda";
import _ from "lodash";
import {MergeDeep} from "type-fest";

const SsmClient = new SSM()

interface ParameterOptions {
    /**
     * Parameter name prefix.
     */
    prefix?: string
    /**
     * Parameters cache TTL in seconds, default 300.
     */
    ttl?: number
    /**
     * SSM client, defaults to `new SSM()`.
     */
    ssm?: SSM
    /**
     * Validate parameters against schema on load, default true.
     */
    relaxed?: boolean,
}

type ParametersSchema = { [key in string]: TSchema }
type Parameters<T extends ParametersSchema> = { [key in keyof T]: Static<T[key]> }

class Bootstrap<T = {}> {

    private options: Required<ParameterOptions>;
    private _parameters: ParametersSchema = {}

    constructor(options?: ParameterOptions) {
        options = options ?? {}
        this.options = {
            ttl: options.ttl ?? 300,
            prefix: options.prefix ?? process.env[`SSM_PREFIX`] ?? "",
            ssm: options.ssm ?? SsmClient,
            relaxed: options.relaxed ?? false
        }
    }

    parameters<P extends ParametersSchema>(parameters: P) {
        const {_parameters} = this

        for (const [key, schema] of Object.entries(parameters)) {
            const existing = _parameters[key]
            if (existing === undefined) {
                _parameters[key] = schema
            } else {
                _parameters[key] = Type.Composite([existing, schema])
            }
        }

        return this as Bootstrap<MergeDeep<T, Parameters<P>>>
    }

    buildConfig(): Config<T> {
        const {ttl} = this.options
        const loadParameters = this.makeParametersLoader()
        const loader = cache(ttl, loadParameters)
        return {
            async reload() {
                return loader(true)
            },

            get parameters(): Promise<T> {
                return loader()
            }
        }
    }

    buildModule<M>(exportsBuilder: (config: T) => M | Promise<M>): Module<T, M> {
        const {ttl} = this.options
        const loadParameters = this.makeParametersLoader()
        async function loadAndBind() {
            const parameters = await loadParameters()
            const exports = await exportsBuilder(parameters)
            return {parameters, exports}
        }

        const loader = cache(ttl, loadAndBind)

        return {
            async reload() {
                return loader(true)
            },

            get parameters(): Promise<T> {
                return loader().then(function ({parameters}) { return parameters })
            },

            get exports(): Promise<M> {
                return loader().then(function ({exports}) { return exports })
            }
        }
    }


    private makeParametersLoader() {
        const parameters = this._parameters
        const {prefix, ssm, relaxed} = this.options

        const params = _(parameters)
            .mapValues(function (v, k) {
                return {schema: v, name: k}
            })
            .mapKeys(function (v, k) {
                if ('parameterName' in v.schema) {
                    k = v.schema.parameterName
                }
                return prefix + k
            })
            .value() as Record<string, { schema: TSchema, name: keyof T }>

        type Parameter = { name: keyof T, schema: TSchema, value?: unknown }

        async function loadParameters() {
            let {Parameters: parameters, InvalidParameters: invalidParameters} = await ssm.getParameters({
                Names: Object.keys(params),
                WithDecryption: true
            })
            invalidParameters = invalidParameters ?? []
            parameters = parameters ?? []
            const storedParameters = parameters.map(parseParameter)
            const defaultParameters = _(invalidParameters).map(defaultParameterValue).compact().value()
            const allParameters = storedParameters.concat(defaultParameters)
            return allParameters.reduce(appendParameterToConfig, {}) as T
        }

        function parseParameter(parameter: SSMParameter): Parameter {
            let {Value: value, Name: parameterName, Type: type} = parameter
            try {
                if (parameterName === undefined)
                    throw internalError("Parameter name is undefined")
                if (value === undefined) value = ""
                const {schema, name} = params[parameterName]
                let v: any = value
                switch (type) {
                    case "SecureString":
                    case "String":
                        if (!TypeGuard.IsString(schema)) {
                            v = JSON.parse(value)
                        }
                        return {schema, name, value: v}
                    case "StringList":
                        v = value.split(",")
                        return {schema, name, value: v}
                    default:
                        throw internalError("Unexpected parameter type.")
                }
            } catch (e: any) {
                throw internalError("Cannot parse parameter").withContext("parseParameter", {
                    cause: e, parameter
                })
            }
        }

        function defaultParameterValue(parameterName: string): Parameter | undefined {
            const parameter = params[parameterName]
            if (parameter !== undefined) {
                const {schema, name} = parameter
                if (schema.default !== undefined) {
                    return {name, schema, value: schema.default}
                }
                if (TypeGuard.IsOptional(schema)) {
                    return {name, schema}
                }
                if (schema.relaxed) {
                    return {name, schema, value: undefined}
                }
            }
            throw internalError("Cannot load required parameter").withContext("defaultParameterValue", {parameter: parameterName})
        }

        function appendParameterToConfig(config: Partial<T>, p: Parameter): Partial<T> {
            const {schema, name, value} = p
            if (relaxed || schema['relaxed']) {
                config[name] = value as any
            } else {
                try {
                    config[name] = Value.Decode(schema, value)
                } catch (e: any) {
                    throw internalError("Cannot parse parameter").withContext("appendParameterToConfig", {
                        cause: e, parameter: p
                    })
                }
            }
            return config
        }

        return loadParameters
    }
}

/**
 * Reloadable module configuration. See for usage and details {@link bootstrap} and {@link reload}.
 */
interface Config<T> {
    /**
     * Return a promise resolving to loaded parameters. See also {@link bootstrap} and {@link reload}.
     */
    parameters: Promise<T>
    /**
     * Force load configuration parameters. This method performs following steps:
     * 1. load parameters from the store, parse according to the target schema type.
     * 2. replace invalid parameters with default values from schemas.
     * 3. fail if some parameters are still invalid and corresponding schemas does not allow undefined values.
     * 4. validate parameters according to their schema and 'relaxed' setting
     * 5. return parameters
     */
    reload(): Promise<T>
}

/**
 * Reloadable module. See for usage and details {@link bootstrap} and {@link reload}.
 */
interface Module<P, E> {

    /**
     * Return module exports. See also {@link bootstrap}.
     */
    exports: Promise<E>

    /**
     * Return a promise resolving to loaded parameters. See also {@link bootstrap} and {@link reload}.
     */
    parameters: Promise<P>

    /**
     * Trigger configuration and exports reload. This method performs following steps:
     * 1. load parameters from the store, parse according to the target schema type.
     * 2. replace invalid parameters with default values from schemas.
     * 3. fail if some parameters are still invalid and corresponding schemas does not allow undefined values.
     * 4. validate parameters according to their schema and 'relaxed' setting
     * 5. build exports object
     * 6. return parameters and exports
     */
    reload(): Promise<{parameters:P, exports:E}>
}

/**
 * Create new module builder. Module configuration is lazily loaded and re-loaded once in a while. Module [exports]{@link Module.exports} are built together with configuration updates.
 * @example Load module configuration
 * const config = bootstrap({prefix: "/test"}).parameters({
 *     users: Type.Object({
 *         table: Type.String(),
 *         pool: Type.String()
 *     })
 * })
 * .buildConfig()
 *
 * const {users} = await config.parameters
 * console.log(users.table, users.pool)
 *
 * @example Load configuration and build module
 *
 * const module = bootstrap({prefix: "/test"}).parameters({
 *     users: Type.Object({
 *         table: Type.String(),
 *         pool: Type.String()
 *     })
 * })
 * .buildModule(function ({table, pool}) {
 *     const usersRepo = new UsersRepo({table, pool})
 *     return {usersRepo}
 * })
 * const {usersRepo} = await config.exports
 * console.log(await usersRepo.allUsers)
 */
export function bootstrap(options?: ParameterOptions) {
    return new Bootstrap(options)
}
