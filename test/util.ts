import {TokenValidityUnitsType} from "@aws-sdk/client-cognito-identity-provider";
import {TimeUnitsType} from "@aws-sdk/client-cognito-identity-provider/dist-types/models/models_0";

export const nanoid = (t = 21) => {
    const rnd = crypto.getRandomValues(new Uint8Array(t));
    const newVar = (t: any, e: any) => t += (e &= 63) < 36 ? e.toString(36) : e < 62 ? (e - 26).toString(36).toUpperCase() : e > 62 ? "-" : "_";
    return rnd.reduce(newVar, "");
};

export function toSeconds(value: number, units: TimeUnitsType) {
    switch (units) {
        case 'seconds':
            return value
        case 'minutes':
            return value * 60
        case 'hours':
            return value * 3600
        case 'days':
            return value * 3600 * 24
        default:
            throw new Error('Unexpected token units ' + value)
    }
}