import _ from "lodash";

export enum LambdaHandler {
    ApiHandler = "api.handler",
    AuthCookieHandler = "authorizer.cookie",
    AuthCodeHandler = "authorizer.code",
    UsersPreSignupHandler = "users.preSignup"
}

export const makeResourceId = _.memoize(function (lambdaHandler: LambdaHandler) {
    const {module, handler} = unpack(lambdaHandler)
    return `${module}-${handler}`
})

export const unpack = _.memoize(function (x: LambdaHandler | string) {
    const a = x.split('.')
    return {
        module: a[0],
        handler: a[1]
    }
})

export function makeLambdaNamer(stack: string) {
    return function (lambdaHandler: LambdaHandler) {
        const {module, handler} = unpack(lambdaHandler)
        return `billntip-${stack}-${module}-${handler}-fn`
    }
}