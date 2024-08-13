import _ from "lodash";
import fs from "fs";
import * as esbuild from "esbuild";
import archiver from "archiver";
import * as upath from "upath";
import {LambdaClient, UpdateFunctionCodeCommand} from "@aws-sdk/client-lambda";

export type LambdaModule = { name: string, handlers: readonly string[], deps?: readonly string[] }
export type Type<T extends LambdaModule> = { [key in T['handlers'][number]]: (...args: any[]) => Promise<any> }
export type LambdaSource = { readonly module: string, readonly handler: string, deps: readonly string[] }

// This line does not compile in Pulumi environment and ok everywhere else.
// https://github.com/pulumi/pulumi/issues/4876
// In November 2020, with the release of TypeScript 4.1, template strings became type-checkable thanks to the
// introduction of template literal types.
// Pulumi uses ts-node 7.0.1 which uses "typescript": "^2.8.3" which does not support template literal types.
// Solution is to override pulumi's typescript version
export type LambdaHandler<T extends LambdaModule> = `${T['name']}.${T['handlers'][number]}`

export type LambdaSet<T extends `${string}.${string}`> = { [key in T]: LambdaSource }

export function lambdaSet() {
    return new LambdaSetBuilder()
}

class LambdaSetBuilder<T extends `${string}.${string}` = never> {

    private set: { [key: `${string}.${string}`]: LambdaSource } = {}

    add<Module extends LambdaModule>(module: Module): LambdaSetBuilder<T | LambdaHandler<Module>> {
        const {name, handlers, deps} = module
        for (let handler of handlers) {
            this.set[`${module.name}.${handler}`] = {module: name, handler, deps: deps ?? []}
        }
        return this as any
    }

    /**
     * Create set of lambda functions from the given modules.
     */
    build(): LambdaSet<T> {
        return this.set as any
    }
}

/**
 * Pick lambda functions matching provided spec from the given lambda set.
 * @param lambdas - lambda set
 * @param spec - lambda spec, either of "all", "module.*" or "module.handler"
 */
export function pickLambdas(lambdas: LambdaSet<any>, spec: string) {
    let [module, handler, ...rest] = spec.split('.')
    if (rest.length > 0) throw new Error(`Unexpected lambda specification ${spec}`)

    if (spec in lambdas) {
        return [lambdas[spec]]
    } else {
        return Object.values(lambdas).filter(function (lambda: LambdaSource) {
            return (module == "*" || lambda.module == module) && (handler == "*" || lambda.handler == handler)
        })
    }

}

const lambdaClient = new LambdaClient();

export interface LambdaBuilderOptions {
    /**
     * Where to put output files. Defaults to "./out"
     */
    readonly outDir?: string
    /**
     * Name of a bundle file in Lambda zip archive. Defaults to "index.js".
     */
    readonly indexFile?: string
    /**
     * ESBuild options
     */
    readonly esBuildOptions?: esbuild.BuildOptions
    /**
     * ESBuild bundles code into `${outDir}/${module}.${bundleSuffix}.js`. Defaults to 'bundle'.
     */
    readonly bundleSuffix?: string
    /**
     * Function to build AWS Lambda name from module and handler.
     */
    readonly lambdaName: (lambdaHandler: LambdaSource) => string
}

export class Builder {

    public readonly outDir: string
    public readonly bundleSuffix: string;

    private readonly _buildTasks: BundleMap
    private readonly esBuildOptions: esbuild.BuildOptions
    private readonly _readArchive: (module: string) => Promise<Uint8Array>

    readonly lambdaName: (lambda: LambdaSource) => string

    constructor(opts: LambdaBuilderOptions) {
        this.outDir = upath.resolve(opts.outDir ?? "./out")
        this.esBuildOptions = opts.esBuildOptions ?? {}
        this.bundleSuffix = opts.bundleSuffix ?? "bundle"
        this.lambdaName = opts.lambdaName
        this._buildTasks = {}
        this._readArchive = _.memoize(async (module: string) => {
            const archivePath = `${this.toArchiveName(module)}.zip`
            return await fs.promises.readFile(archivePath);
        })
    }

    /**
     * Return started build tasks.
     */
    public get buildTasks(): Readonly<BundleMap> {
        return this._buildTasks
    }

    /**
     * Bundle and archive TypeScript entry point.
     */
    public bundle(src: LambdaSource, type: "ts" | "js" = "ts",): Promise<string> {
        const entryPoint = src.module
        const stack = new Error().stack
        let cached = this._buildTasks[entryPoint]
        if (cached == null) {
            this._buildTasks[entryPoint] = cached = this._bundle(src, type, stack)
        }
        return cached
    }

    private async _bundle(src: LambdaSource, type: "ts" | "js", stack: any) {
        const module = src.module
        const outfile = this.toArchiveName(module)
        const buildOptions = this.esBuildOptions

        try {
            const lambdaEntryPoint = await entryPoint(this.esBuildOptions.absWorkingDir ?? "./");
            console.log("Building ", lambdaEntryPoint, ' to ', outfile)
            await esbuild.build({
                ...buildOptions,
                entryPoints: [lambdaEntryPoint],
                bundle: true,
                platform: "node",
                outfile: outfile,
            })
        } catch (e) {
            console.error(`esbuild failed building ${module}`)
            console.error(stack)
            throw e
        }
        const bundleArchive = archiver("zip", {
        });
        const archive = `${outfile}.zip`;
        const dstZip = fs.createWriteStream(archive);
        const zipTask = new Promise(function (resolve, reject) {
            dstZip.on('close', (x: any) => {
                resolve(x)
            });
            dstZip.on('error', (err) => {
                reject(err)
            });
        })
        bundleArchive.pipe(dstZip)

        bundleArchive
            .file(outfile, {name: `function.js`})
            .file(upath.joinSafe(__dirname, "init.mjs"), {name: `index.mjs`})
            .file(`${outfile}.map`, {name: upath.basename(`${outfile}.map`)})

        for (const dep of src.deps) {
            const dir = upath.joinSafe('node_modules', dep);
            bundleArchive.directory(dir, dir)
        }

        await bundleArchive.finalize()
        await zipTask
        return archive

        async function entryPoint(workDir: string) {
            const file = upath.resolve(workDir ?? "./", `${module}.${type}`)
            try {
                const stat = await fs.promises.stat(file)
                if (stat.isFile()) {
                    return file
                } else if (stat.isDirectory()) {
                    return upath.joinSafe(module, `index.${type}`)
                }
            } catch (e) {
                if (e !== null && typeof e === 'object' && 'code' in e && e.code == 'ENOENT') {
                    return upath.joinSafe(module, `index.${type}`)
                }
                throw e
            }
            throw new Error(`Unknown file system entry ${file}`)
        }
    }

    /**
     * Update AWS Lambda function.
     */
    public async update(lambda: LambdaSource, publish: boolean = true) {
        const {module} = lambda
        const zip = await this._readArchive(module)
        const update = new UpdateFunctionCodeCommand({
            FunctionName: this.lambdaName(lambda),
            ZipFile: zip,
            Publish: publish
        })
        return await lambdaClient.send(update)
    }

    private toArchiveName(module: string) {
        return upath.joinSafe(this.outDir, `${module}.${this.bundleSuffix}.js`)
    }
}

type BundleMap = {
    [key: string]: Promise<string>
}
