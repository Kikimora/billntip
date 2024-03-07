import {tokenValidity} from "./settings";

type TokenType = "accessToken" | "idToken" | 'refreshToken'

export function tokenValidityInSeconds(token: TokenType) {
    const tokenUnits = tokenValidity.tokenValidityUnits[token] ?? 'hours'
    const tokenValue = (tokenValidity as any)[`${token}Validity`] as number
    switch (tokenUnits) {
        case 'seconds':
            return tokenValue
        case 'minutes':
            return tokenValue * 60
        case 'hours':
            return tokenValue * 3600
        case 'days':
            return tokenValue * 3600 * 24
        default:
            throw new Error('Unexpected token units ' + tokenUnits)
    }
}
