import * as upath from "upath";
import fs from 'fs'
import _ from "lodash";
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

export const Pay = {
    name: "billntip/pay",
    handlers: ["handler"]
} as const

export const MangopayHooks = {
    name: "billntip/mangopay-hooks",
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
    .add(Pay)
    .add(MangopayHooks)
    .add(Images)
    .build()

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
