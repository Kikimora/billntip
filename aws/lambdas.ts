import * as upath from "upath";
import fs from 'fs'
import _ from "lodash";
import * as aws from "@pulumi/aws";
import {newLambda} from "@aws/util";
import {configFolder, stack, tags} from "@aws/config";
import {Builder, LambdaSource, lambdaSet} from "@app/lambda/builder";

export const Authorizer = {
    name: "authorizer",
    handlers: ["code", "tokens", "cookie"]
} as const

export const Bill = {
    name: "billntip/bill",
    handlers: ["handler"]
} as const

export const Tip = {
    name: "billntip/tip",
    handlers: ["handler"]
} as const

export const Users = {
    name: "users",
    handlers: ["handler"]
} as const

export const Cognito = {
    name: "users/cognito-triggers",
    handlers: ["handler"]
} as const

export const Images = {
    name: "images",
    handlers: ["handler"],
    deps: ['@img/sharp-libvips-linux-arm64', '@img/sharp-linux-arm64']
} as const

export const Lambdas = lambdaSet()
    .add(Authorizer)
    .add(Users)
    .add(Cognito)
    .add(Bill)
    .add(Tip)
    .add(Images)
    .build()

export const Modules = [
    'authorizer.code',
    'authorizer.tokens',
    'authorizer.cookie',
]

function makeLambdaNamer(stack: string) {
    return function (lambda: LambdaSource) {
        const {module, handler} = lambda
        return `billntip-${stack}-${module}-${handler}-fn`.replace('/', '-')
    }
}

export const makeBuilder = _.memoize(function (stack) {

    function isModuleRoot(path: string) {
        let fd = 0
        try {
            fd = fs.openSync(upath.joinSafe(path, "package.json"), "r")
            return true
        } catch (e: any) {
            if (e.code == 'ENOENT') return false
            throw e
        } finally {
            if (fd != 0) fs.closeSync(fd)
        }
    }

    let path = upath.resolve(".");
    while (!isModuleRoot(path)) {
        path = upath.dirname(path)
    }

    return new Builder({
        outDir: upath.joinSafe(path, "./out"),
        esBuildOptions: {
            absWorkingDir: upath.joinSafe(path, "./src"),
            tsconfig: upath.joinSafe(path, "./tsconfig.json"),
            sourcemap: true
        },
        lambdaName: makeLambdaNamer(stack)
    })
})

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
            SSM_PREFIX: configFolder
        }
    },
    timeout: 10,
    tags
}
newLambda.builder = makeBuilder(stack)