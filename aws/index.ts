// noinspection JSUnusedGlobalSymbols
import * as dotenv from "@dotenvx/dotenvx";
import * as upath from "upath";
import * as fs from "fs";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import {newLambda} from "@aws/util";
import {makeBuilder} from "./lambdas";
import {configFolder, stack, tags} from "./config";

dotenv.config();

const nodejs20xRuntime = "nodejs20.x" as aws.lambda.Runtime;
newLambda.defaults = {
    runtime: nodejs20xRuntime,
    architectures: ["arm64"],
    memorySize: 256,
    loggingConfig: {
        logFormat: "JSON",
        systemLogLevel: stack == "dev" ? "DEBUG" : "WARN",
    },
    environment: {
        variables: {
            NODE_OPTIONS: '--enable-source-maps',
            SSM_PREFIX: `/${configFolder}/`,
            ENV: stack
        }
    },
    timeout: 10,
    tags
}
newLambda.builder = makeBuilder(stack)

// Outputs

import Cognito from "./cognito"
import {cognitoClients} from "./api"

export const cognito = {
    ...Cognito,
    clients: cognitoClients
}
export {default as dynamodb} from "./dynamodb"
export {default as api} from "./api"
export * as s3 from "./s3"

const outputsCachePath = upath.join(__dirname, "../out", `resources.${stack}.json`)
pulumi.all({...exports}).apply(x => {
    fs.writeFileSync(outputsCachePath, JSON.stringify(x, null, 2))
    console.log(`Outputs written to ${outputsCachePath}`)
})
