import {z} from "zod";

export const AuthModuleContextSchema = z.object({
    cookieName: z.string().min(1).readonly(),
    sessionTable: z.string().min(1).readonly(),
    refreshTokenTtlSec: z.number().min(300).readonly(),
    cacheTtlSec: z.number().min(120).readonly(),

    clientId: z.string().min(1).readonly(),
    issuer: z.string().min(1).readonly(),
    tokenEndpoint: z.string().url().readonly(),
    postAuthRedirectUrl: z.string().url().readonly(),

    region: z.string().min(1).readonly(),
    now: z.number()
})

export type AuthModuleContext = z.infer<typeof AuthModuleContextSchema>
export type AuthModuleOptions = Partial<Omit<AuthModuleContext, 'now' | 'region'>>
