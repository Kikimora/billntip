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

class ConfigBuilder<T = {}> {

    private binders: ((x: any) => void)[] = []
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

    bind(fn: (config: T) => void) {
        this.binders.push(fn)
        return this
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

        return this as ConfigBuilder<MergeDeep<T, Parameters<P>>>
    }

    build(): ModuleConfig<T> {
        const binders = Array.from(this.binders)
        const parameters = this._parameters
        const {ttl, prefix, ssm, relaxed} = this.options

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

        function bindParameters(config: T) {
            binders.forEach(x => x(config))
        }

        async function loadAndBind() {
            const parameters = await loadParameters()
            bindParameters(parameters)
            return parameters
        }

        const loader = cache(ttl, loadAndBind)

        return {
            async load() {
                return await loader(true)
            },

            get parameters(): Promise<T> {
                return loader()
            }
        }
    }
}

/**
 * Reloadable module configuration. See for usage and details {@link moduleConfig} and {@link load}.
 */
interface ModuleConfig<T> {
    /**
     * Return a promise resolving to loaded parameters. See also {@link moduleConfig} and {@link load}.
     */
    parameters: Promise<T>

    /**
     * Force load configuration parameters. This method performs following steps:
     * 1. load parameters from the store, parse according to the target schema type.
     * 2. replace invalid parameters with default values from schemas.
     * 3. fail if some parameters are still invalid and corresponding schemas does not allow undefined values.
     * 4. validate parameters according to their schema and 'relaxed' setting
     * 5. run binder functions
     * 6. return parameters
     */
    load(): Promise<T>
}

/**
 * Make module configuration builder. The configuration is lazily loaded and re-loaded once in a while.
 * @example
 * const config = moduleConfig({prefix: "/test"}).parameters({
 *     users: Type.Object({
 *         table: Type.String(),
 *         pool: Type.String()
 *     })
 * })
 *
 * const {users} = await config.parameters
 * console.log(users.table, users.pool)
 */
export function moduleConfig(options?: ParameterOptions) {
    return new ConfigBuilder(options)
}
