import {postAuthentication, preTokenGeneration} from "@src/users";
import {resources} from "@app/test/util";
import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";
import {Tracer} from "@app/diagnostics";

let userPool: string
const tracer = new Tracer("users.test")
beforeAll(() => {
    const r = resources()
    userPool = r.cognito.userPool.id
})

const cognito = new CognitoIdentityProvider()

describe("Cognito user pool", () => {
    let event!: any
    let recordEvent!: jest.SpyInstance;
    beforeEach(() => {
        recordEvent = jest.spyOn(tracer as any, 'recordEvent')
        event = {
            userPoolId: userPool,
            request: {
                userAttributes: {},
                groupConfiguration: {
                    groupsToOverride: []
                }
            }
        }
        Object.defineProperty(event, 'tracer', {value: tracer.startSession("", event), enumerable: false})
    })

    afterEach(async () => {
        event.tracer.done()
        jest.clearAllMocks()
        try {
            if (event.userName !== undefined) {
                await cognito.adminDeleteUser({Username: event.userName, UserPoolId: event.userPoolId})
            }
        } catch (e) {
            //ignore
        }
    })

    it.each([
        ["email", "test@example.com"],
        ["phone_number", "+351111111111"],
    ])("verifies %s after successful login", async (attribute, userName) => {
        event.userName = userName
        event.triggerSource = "PostAuthentication_Authentication"
        //arrange - create a user
        await adminCreateUser(event);
        //act - imitate successful login
        await postAuthentication(event, {} as any)
        //assert - username attribute verified
        const user = await cognito.adminGetUser({
            Username: event.userName,
            UserPoolId: event.userPoolId
        })
        event.tracer.info("User after test", user)
        expect(user.UserAttributes).toEqual(expect.arrayContaining([{
            Name: `${attribute}_verified`, Value: "true"
        }]))
    })

    it.each([
        ["email", "test@example.com"],
        ["phone_number", "+351111111111"],
    ])("does nothing if %s already verified", async (attribute, userName) => {
        event.userName = userName
        event.triggerSource = "PostAuthentication_Authentication"
        const adminUpdateUserAttributes = jest.spyOn(cognito, 'adminUpdateUserAttributes')
        //arrange - create a user
        await adminCreateUser(event, {
            [attribute]: userName,
            [`${attribute}_verified`]: "true"
        })
        //act - imitate successful login
        await postAuthentication(event, {} as any)
        //assert - username attribute verified
        expect(adminUpdateUserAttributes).not.toHaveBeenCalled()
    })
})

async function adminCreateUser(event: {
    userName: string,
    userPoolId: string
}, attributes?: Record<string, string>) {
    const attrs = attributes !== undefined
        ? Object.entries(attributes).map(([k, v]) => ({Name: k, Value: v}))
        : []
    await cognito.adminCreateUser({
        Username: event.userName,
        UserPoolId: event.userPoolId,
        TemporaryPassword: "Qweqwe_1",
        MessageAction: "SUPPRESS",
        UserAttributes: attrs
    })
}
