import {program} from 'commander';
import * as _ from "lodash";
import * as dotenv from 'dotenv';
import {LambdaSource, pickLambdas} from "@app/lambda/builder";
import {Lambdas, makeBuilder} from "@aws/lambdas";

dotenv.config();

program
    .option('-b, --build', 'Build lambda functions code')
    .option('-p, --publish', 'Publish lambda functions, implies -u')
    .option('-s, --stack <stack>', 'Deploy to stack', 'dev')
    .argument('<handlers...>', 'Lambda handlers (Ex: api.handler, api.* or all)')
    .action(async function (handlers: string[], options) {

        const lambdas = handlers.flatMap(function (spec: string): LambdaSource[] {
            return pickLambdas(Lambdas, spec)
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
    return async function (lambda: LambdaSource) {
        const {module} = lambda
        const builder = makeBuilder(options.stack);
        if (options.build && !builder.buildTasks[module]) {
            console.log("Building: ", module)
            // noinspection ES6MissingAwait
            builder.bundle(lambda)
        }
        await Promise.all(_.values(builder.buildTasks))

        if (options.createTokens || options.publish) {
            console.log("Updating AWS Lambda: ", lambda)
            await builder.update(lambda, options.publish)
        }
    }
}