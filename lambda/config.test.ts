import {SSM} from "@aws-sdk/client-ssm";
import {moduleConfig} from "@app/lambda/config";
import {Type} from "@sinclair/typebox";
import {errorContext, ErrorContext} from "@app/diagnostics";

const ssm = new SSM()
const prefix = '/test/' + new Date().toISOString().replaceAll(':', '-') + '/'
const parameters = {
    locks: prefix + 'locks',
    users: prefix + 'users',
    list: prefix + 'list',
}
const usersConfig = {
    cookieName: 'SID',
    sessionTable: 'billntip-dev-sessions',
    locksTable: 'billntip-dev-locks',
    userPoolId: 'eu-south-1_xCtFj6q8X',
    clientId: '3omts8kdqp2oh292oj1ljo8pir',
    issuer: 'https://cognito-idp.eu-south-1.amazonaws.com/eu-south-1_xCtFj6q8X',
    tokenEndpoint: 'https://billntip-dev.auth.eu-south-1.amazoncognito.com/oauth2/token',
    postAuthRedirectUrl: 'https://91cdkha2y8.execute-api.eu-south-1.amazonaws.com/dev/auth/cognito/idpresponse',
    region: 'eu-south-2',
    authorizerCacheTtl: 3600,
    sameSite: "strict"
};
const locksTable = 'arn:aws:dynamodb:eu-south-1:381491945919:table/billntip-dev-locks';
beforeAll(async () => {
    const locks = ssm.putParameter({
        Name: parameters.locks,
        Value: locksTable,
        Type: "String",
        Tags: [{Key: "Purpose", Value: "Test"}]
    })
    const users = ssm.putParameter({
        Name: parameters.users,
        Type: "String",
        Value: JSON.stringify(usersConfig),
        Tags: [{Key: "Purpose", Value: "Test"}]
    })
    const stringList = ssm.putParameter({
        Name: parameters.list,
        Type: "StringList",
        Value: "A,B,12",
        Tags: [{Key: "Purpose", Value: "Test"}]
    })
    await Promise.all([locks, users, stringList])
})

afterAll(async () => {
    await ssm.deleteParameters({
        Names: Object.values(parameters)
    })
})

it("read config", async () => {
    const config = moduleConfig({prefix}).parameters({
        locks: Type.String(),
        users: Type.Object({
            cookieName: Type.String(),
            sessionTable: Type.String(),
            locksTable: Type.String(),
            userPoolId: Type.String(),
            clientId: Type.String(),
            issuer: Type.String(),
            tokenEndpoint: Type.String(),
            postAuthRedirectUrl: Type.String(),
            region: Type.String(),
            authorizerCacheTtl: Type.Number(),
            sameSite: Type.String(),
        }),
    }).build()

    const {locks, users} = await config.parameters
    expect(locks).toEqual(locksTable)
    expect(users).toEqual(usersConfig)
})

it("validates schema", async () => {
    const config = moduleConfig({prefix}).parameters({
        locks: Type.String({maxLength: 2})
    }).build()

    await expect(config.parameters).rejects.toEqual(expect.objectContaining({
        message: "Cannot parse parameter",
        [ErrorContext]: expect.arrayContaining([expect.objectContaining({
            cause: expect.objectContaining({
                message: "Unable to decode value as it does not match the expected schema",
                error: expect.objectContaining({message: "Expected string length less or equal to 2"})
            })
        })])
    }))
})

it("allows relax overrides and schema violations", async () => {
    const config = moduleConfig({relaxed: false, prefix}).parameters({
        locks: Type.String({maxLength: 2, relaxed: true}),
    }).build()
    const {locks} = await config.parameters
    expect(locks).toEqual(locksTable)
})

it("parses StringList", async () => {
    const config = moduleConfig({prefix}).parameters({
        list: Type.Array(Type.String()),
    }).build()
    const {list} = await config.parameters
    expect(list).toEqual(["A", "B", "12"])
})

it("throws on invalid JSON", async () => {
    const config = moduleConfig({prefix}).parameters({
        locks: Type.Object({})
    }).build()
    await expect(config.parameters).rejects.toEqual(expect.objectContaining({
        message: "Cannot parse parameter"
    }))
})

it("overrides parameter name", async () => {
    const config = moduleConfig({prefix: ""}).parameters({
        locks: Type.String({parameterName: parameters.locks})
    }).build()
    const {locks} = await config.parameters
    expect(locks).toEqual(locksTable)
})

it("merges parameters", async () => {
    const config = moduleConfig({prefix})
        .parameters({
            locks: Type.String(),
            users: Type.Object({
                cookieName: Type.String(),
            })
        })
        .parameters({
            users: Type.Object({
                sessionTable: Type.String()
            })
        })
        .build()
    const {locks, users} = await config.parameters
    expect(locks).toEqual(locksTable)
    expect(users).toEqual(expect.objectContaining({
        cookieName: usersConfig.cookieName,
        sessionTable: usersConfig.sessionTable
    }))
})

it("uses default if parameter is not found", async () => {
    const config = moduleConfig({prefix})
        .parameters({
            notFound: Type.String({default: "Default Value"}),
            notFoundRelaxed: Type.String({relaxed:true, default: "Default Value"})
        })
        .build()
    const {notFound, notFoundRelaxed} = await config.parameters
    expect(notFound).toEqual("Default Value")
    expect(notFoundRelaxed).toEqual("Default Value")
})