import _ from "@app/util";
import {AttributeType} from "@aws-sdk/client-cognito-identity-provider/dist-types/models/models_0";


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
