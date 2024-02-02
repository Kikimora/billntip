import * as path from "upath";
import {program} from 'commander';
import * as _ from "lodash";
import * as dotenv from 'dotenv';
import {LambdaBuilder} from "./lambdas";
import {LambdaHandler, makeLambdaNamer, unpack} from "./billntip-lambdas"

dotenv.config();

const getBuilder = _.memoize(function (stack: string) {
    return new LambdaBuilder({
        outDir: "./out",
        esBuildOptions: {
            absWorkingDir: path.resolve("./src"),
            tsconfig: "../tsconfig.json",
        },
        lambdaName: makeLambdaNamer(stack)
    })
})

const Handlers = new Set<string>(Object.values(LambdaHandler))
const Modules = new Set(Object.values(LambdaHandler).map(unpack).map(x => x.module))

program
    .option('-b, --build', 'Update lambda functions code')
    .option('-u, --update', 'Update lambda functions code')
    .option('-p, --publish', 'Publish lambda functions, implies -u')
    .option('-s, --stack <stack>', 'Deploy to stack', 'dev')
    .argument('<handlers...>', 'Lambda handlers (Ex: api.handler, api.* or all)')
    .action(async function (handlers: string[], options) {

        const lambdas = handlers.flatMap(function (spec: string): LambdaHandler[] {
            const {module, handler} = unpack(spec)
            if (Handlers.has(spec)) {
                return [spec as LambdaHandler]
            } else if (module == "all" && handler === undefined) {
                return Array.from(Handlers) as LambdaHandler[]
            } else if (Modules.has(module) && handler == "*") {
                return Array.from(allHandlers(module)) as LambdaHandler[]
            }
            throw new Error(`Unexpected lambda handler specification ${spec}`)
        })

        try {
            const tasks = _.uniq(lambdas).map(buildAndUpdate(options))
            await Promise.all(tasks)
            console.log('Done!')
        } catch (e) {
            console.log(e)
            process.exit(1)
        }
    });
program.parse(process.argv.slice(1))

function buildAndUpdate(options: any) {
    return async function (lambdaHandler: LambdaHandler) {
        const {module} = unpack(lambdaHandler)
        const builder = getBuilder(options.stack);
        if (options.build && !builder.buildTasks[module]) {
            console.log("Building: ", module)
            // noinspection ES6MissingAwait
            builder.bundle(module)
        }
        await Promise.all(_.values(builder.buildTasks))

        if (options.update || options.publish) {
            console.log("Updating AWS Lambda: ", lambdaHandler)
            await builder.update(lambdaHandler, options.publish)
        }
    }
}

function* allHandlers(targetModule: string) {
    for (const lambdaHandler of Handlers.values()) {
        const {module} = unpack(lambdaHandler)
        if (module == targetModule) yield lambdaHandler
    }
}