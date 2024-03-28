import {z} from "zod";
import _ from "lodash";
import {userPoolDetails} from "../cognito";
import {toSeconds} from "@app/util";
import {EMF, Tracer} from "@app/diagnostics";

export const AuthTracer = new Tracer("authorizer")
export const Metrics = EMF.namespace("authorizer")
    .dimensions("functionVersion")
    .metric("tokenVerificationLatency", {units: "Milliseconds"})
    .startReporter()

export const AuthModuleEnvSchema = z.object({
    cookieName: z.string().min(1).readonly(),
    sessionTable: z.string().min(1).readonly(),
    locksTable: z.string().min(1).readonly(),

    clientId: z.string().min(1).readonly(),
    userPoolId: z.string().min(1).readonly(),
    issuer: z.string().min(1).readonly(),
    tokenEndpoint: z.string().url().readonly(),
    postAuthRedirectUrl: z.string().url().readonly(),

    /**
     * Authorizer cache TTL in seconds
     */
    authorizerCacheTtl: z.number().min(1).readonly(),

    region: z.string().min(1).readonly(),
})

/**
 * Authentication module environment as provided to Lambda function
 */
export type AuthModuleEnv = z.infer<typeof AuthModuleEnvSchema>

/**
 * Authentication module operation environment, something that changes from one operation invocation to another.
 */
export interface AuthModuleVariables {
    /**
     * Operation start time in **seconds** since the [epoch]{@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date#the_epoch_timestamps_and_invalid_date}.
     */
    now: number,
    requestId: string,
    clientSecret: string
    /**
     * Access token TTL in seconds
     */
    accessTokenTtl: number
    /**
     * Refresh token TTL in seconds
     */
    refreshTokenTtl: number
}

/**
 * Static environment variables.
 */
export const Env: AuthModuleEnv = AuthModuleEnvSchema.parse({
    cookieName: process.env.COOKIE_NAME ?? 'SID',
    sessionTable: process.env.SESSION_TABLE ?? 'sessions',
    locksTable: process.env.LOCKS_TABLE ?? 'locks',
    userPoolId: process.env.USER_POOL_ID,
    clientId: process.env.OAUTH_CLIENT_ID, //user pool client id
    issuer: process.env.OAUTH_ISSUER,
    tokenEndpoint: process.env.OAUTH_TOKEN_ENDPOINT,
    postAuthRedirectUrl: process.env.POST_AUTH_REDIRECT_URL,
    region: process.env.AWS_REGION,
    authorizerCacheTtl: Number(process.env.AUTHORIZER_CACHE_TTL),
})

let variables: AuthModuleVariables

/**
 * Return variables that change from one request to another.
 */
export function useVariables() {
    if (variables == null) {
        throw new Error("Cannot use auth module variables. Call `startAuthOperation()` before the call to `useVariables()`")
    }
    return variables
}

/**
 * Init module variables reported by {@link useVariables}
 * @param requestId - request id
 */
export async function initModuleVariables(requestId?: string) {
    const {userPoolId, clientId} = Env
    const userPoolClient = await userPoolDetails(userPoolId, clientId)
    const units = userPoolClient.TokenValidityUnits ?? _.throw("User pool must have tokens validity setting.")
    const accessTokenTtl = userPoolClient.AccessTokenValidity ?? _.throw("User pool must have access token validity setting.");
    const accessTokenUnits = units.AccessToken ?? _.throw("User pool must have access token validity setting.")
    const refreshTokenTtl = userPoolClient.RefreshTokenValidity ?? _.throw("User pool must have refresh token validity setting.");
    const refreshTokenUnits = units.RefreshToken ?? _.throw("User pool must have refresh token validity setting.")
    variables = {
        now: Math.floor((performance.now() + performance.timeOrigin) / 1000),
        requestId: requestId ?? "",
        clientSecret: userPoolClient.ClientSecret ?? _.throw("User pool must have a client secret configured."),
        accessTokenTtl: toSeconds(accessTokenTtl, accessTokenUnits),
        refreshTokenTtl: toSeconds(refreshTokenTtl, refreshTokenUnits)
    }
    return variables
}
