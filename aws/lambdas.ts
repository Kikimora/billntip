import * as upath from "upath";
import fs from 'fs'
import {Builder, LambdaSource, lambdaSet} from "@app/lambda/builder";
import _ from "lodash";
import * as pulumi from "@pulumi/pulumi";
import {newLambda} from "@aws/util";
import * as aws from "@pulumi/aws";

export const Authorizer = {
    name: "authorizer",
    handlers: ["code", "tokens", "cookie"]
} as const

export const Api = {
    name: "api",
    handlers: ["handler"]
} as const

export const Bill = {
    name: "bill",
    handlers: ["handler"]
} as const

export const Tip = {
    name: "tip",
    handlers: ["handler"]
} as const

export const Users = {
    name: "users",
    handlers: ["handler"]
} as const

export const Cognito = {
    name: "cognito-triggers",
    handlers: ["preSignup", "postSignup", "info", "preTokenGeneration", "postAuthentication", ]
} as const

export const Lambdas = lambdaSet().add(Authorizer).add(Api).add(Cognito).add(Users).add(Bill).add(Tip).build()

function makeLambdaNamer(stack: string) {
    return function (lambda: LambdaSource) {
        const {module, handler} = lambda
        return `billntip-${stack}-${module}-${handler}-fn`
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
    loggingConfig: {
        logFormat: "JSON",
        systemLogLevel: pulumi.getStack() == "dev" ? "DEBUG" : "WARN",
    },
    environment: {
        variables: {
            NODE_OPTIONS: '--enable-source-maps'
        }
    }
}
newLambda.builder = makeBuilder(pulumi.getStack())