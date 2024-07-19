import _ from "@app/util";
import {AttributeType} from "@aws-sdk/client-cognito-identity-provider/dist-types/models/models_0";
import {generate} from "generate-password";
import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {LRUCache} from "lru-cache";
import {internalError} from "@app/lambda";

const cognito = new CognitoIdentityProvider()

export function toUserAttributes(attributes?: AttributeType[]) {
    const verifiers = _(attributes)
        .filter(x => x.Name?.endsWith('_verified') ?? false)
        .keyBy('Name')
        .mapKeys((_1, k) => k.substring(0, k.length - 9 /*_verified.length*/))
        .mapValues('Value')
        .value()
    return _(attributes)
        .map(function (x) {
            if (x.Name === undefined || x.Value === undefined) {
                return undefined
            }
            if (x.Name.endsWith('_verified')) return undefined
            const verified = verifiers[x.Name]
            if (verified === 'true')
                return {name: x.Name, value: x.Value, verified: true}
            return {name: x.Name, value: x.Value}
        })
        .compact()
        .value()
}

const describeUserPool = _.memoize(async function (userPoolId: string, provider: CognitoIdentityProvider = cognito) {
    const r = await provider.describeUserPool({UserPoolId: userPoolId})
    if (_.isNull(r?.UserPool)) throw new Error(`UserPool ${userPoolId} not found`)
    return r.UserPool!
})
describeUserPool.cache = new LRUCache({max: 10, ttl: 1000 * 60 * 5})

export async function generatePassword(userPoolId: string, provider: CognitoIdentityProvider = cognito) {
    const userPool = await describeUserPool(userPoolId, provider)
    if (userPool === undefined) throw internalError("Unexpected error: cognito didn't return user pool details.")

    const passwordPolicy = userPool.Policies?.PasswordPolicy
    if (passwordPolicy === undefined) throw internalError("Unexpected error: cognito user pool does not have a password policy.")
    return generate({
        length: passwordPolicy.MinimumLength ?? 6,
        uppercase: passwordPolicy.RequireUppercase,
        lowercase: passwordPolicy.RequireLowercase,
        numbers: passwordPolicy.RequireNumbers,
        symbols: passwordPolicy.RequireSymbols,
        strict: true,
    })
}

