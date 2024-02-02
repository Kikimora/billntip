import * as _ from "lodash";
import * as esbuild from "esbuild";
import * as path from "upath";
import * as fs from "fs";
import archiver from "archiver";
import {LambdaClient, UpdateFunctionCodeCommand} from "@aws-sdk/client-lambda";
import {BuildOptions} from "esbuild";
import {LambdaHandler, unpack} from "./billntip-lambdas";

type BundleMap = {
    [key: string]: Promise<string>
}

const lambda = new LambdaClient();

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
    readonly esBuildOptions?: BuildOptions
    /**
     * ESBuild bundles code into `${outDir}/${module}.${bundleSuffix}.js`. Defaults to 'bundle'.
     */
    readonly bundleSuffix?: string
    /**
     * Function to build AWS Lambda name from module and handler.
     */
    readonly lambdaName: (lambdaHandler: LambdaHandler) => string
}

export class LambdaBuilder {

    public readonly outDir: string
    public readonly bundleSuffix: string;

    private readonly _buildTasks: BundleMap
    private readonly esBuildOptions: BuildOptions
    private readonly _readArchive: (module: string) => Promise<Uint8Array>
    private readonly _makeLambdaName: (lambdaHandler: LambdaHandler) => string

    constructor(opts: LambdaBuilderOptions) {
        this.outDir = path.resolve(opts.outDir ?? "./out")
        this.esBuildOptions = opts.esBuildOptions ?? {}
        this.bundleSuffix = opts.bundleSuffix ?? "bundle"
        this._makeLambdaName = opts.lambdaName
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
    public bundle(entryPoint: string): Promise<string> {
        let cached = this._buildTasks[entryPoint]
        if (cached == null) {
            this._buildTasks[entryPoint] = cached = this._bundle(entryPoint)
        }
        return cached
    }

    private async _bundle(module: string, type: "ts" | "js" = "ts") {
        const outfile = this.toArchiveName(module)
        const buildOptions = this.esBuildOptions
        await esbuild.build({
            ...buildOptions,
            entryPoints: [`${module}.${type}`],
            bundle: true,
            platform: "node",
            outfile: outfile
        })
        const bundleArchive = archiver("zip", {});
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
        await bundleArchive
            .file(outfile, {name: `index.js`})
            .finalize()
        await zipTask
        return archive
    }

    /**
     * Update AWS Lambda function.
     */
    public async update(lambdaHandler: LambdaHandler, publish: boolean = true) {
        const {module} = unpack(lambdaHandler)
        const zip = await this._readArchive(module)
        const update = new UpdateFunctionCodeCommand({
            FunctionName: this._makeLambdaName(lambdaHandler),
            ZipFile: zip,
            Publish: publish
        })
        return await lambda.send(update)
    }

    private toArchiveName(module: string) {
        return path.join(this.outDir, `${module}.${this.bundleSuffix}.js`)
    }
}
