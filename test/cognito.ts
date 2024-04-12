import {
    AdminAddUserToGroupCommand,
    AdminCreateUserCommand,
    AdminDeleteUserCommand,
    AdminInitiateAuthCommand,
    AdminSetUserPasswordCommand, CognitoIdentityProvider,
    CreateGroupCommand, DescribeUserPoolClientCommand,
    GetGroupCommand, GetUserCommandOutput,
    GroupType
} from "@aws-sdk/client-cognito-identity-provider";
import {createHmac} from 'crypto';
import {TokenEndpointResponse} from "@src/authorizer/oidc_tokens";
import {retry} from "@app/util";
import shortUUID from "short-uuid";

const cognito = new CognitoIdentityProvider()
const password = "Qweqwe_1";

export interface TestUser {
    readonly username: string;

    login(): Promise<TokenEndpointResponse>;

    data(): Promise<GetUserCommandOutput>;

    delete(): Promise<void>;
}

export interface TestGroup {
    createUniqueUser(): Promise<TestUser>;
}

export interface TestCognitoModule {
    loadTestGroup(): Promise<TestGroup>

}

const shortUUIDGenerator = shortUUID(shortUUID.constants.flickrBase58)

export default {
    init,
    client: cognito
}

export async function init(userPoolId: string, userPoolClientId: string): Promise<TestCognitoModule> {

    const userPoolClient = await cognito.send(new DescribeUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientId: userPoolClientId
    }))
    const secret = userPoolClient!.UserPoolClient!.ClientSecret!;

    class TestUserImpl implements TestUser {

        private tokens?: TokenEndpointResponse

        constructor(readonly username: string) {
        }

        async login() {
            const hasher = createHmac('sha256', secret);
            hasher.update(`${this.username}${userPoolClientId}`);
            let output = hasher.digest('base64');

            const loginCommand = new AdminInitiateAuthCommand({
                UserPoolId: userPoolId,
                AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
                ClientId: userPoolClientId,
                AuthParameters: {
                    "USERNAME": this.username,
                    "PASSWORD": password,
                    "SECRET_HASH": output
                }
            })
            const response = await cognito.send(loginCommand)
            const result = response.AuthenticationResult!
            return this.tokens = {
                access_token: result.AccessToken!,
                id_token: result.IdToken!,
                refresh_token: result.RefreshToken!,
                expires_in: result.ExpiresIn!
            }
        }

        async data(): Promise<GetUserCommandOutput> {
            if (this.tokens === undefined) throw new Error("Call login first")
            return await cognito.getUser({
                AccessToken: this.tokens.access_token
            })
        }

        async delete() {
            const deleteUserCommand = new AdminDeleteUserCommand({
                UserPoolId: userPoolId,
                Username: this.username
            })
            await cognito.send(deleteUserCommand)
        }
    }

    class TestGroupImpl implements TestGroup {

        constructor(public readonly group: GroupType) {

        }

        public static async loadTestGroup() {
            return retry(async () => {
                try {
                    const getGroupCommand = new GetGroupCommand({
                        UserPoolId: userPoolId,
                        GroupName: "Test"
                    })
                    const group = await cognito.send(getGroupCommand)
                    return new TestGroupImpl(group.Group!)
                } catch (e) {
                    const createGroupCommand = new CreateGroupCommand({
                        UserPoolId: userPoolId,
                        GroupName: "Test",
                        Description: "Group with test users"
                    })
                    const group = await cognito.send(createGroupCommand)
                    return new TestGroupImpl(group.Group!)
                }
            }, {maxIterations: 3, delay: 1000})
        }

        async createUniqueUser() {
            const username = `${shortUUIDGenerator.generate()}@mailinator.com`
            const signupCommand = new AdminCreateUserCommand({
                UserPoolId: userPoolId,
                Username: username,
                MessageAction: "SUPPRESS",
                UserAttributes: [
                    {Name: "email_verified", Value: "true"},
                    {Name: "email", Value: username},
                    {Name: "phone_number_verified", Value: "true"},
                    {Name: "phone_number", Value: "+79219736635"},
                ]
            })
            await cognito.send(signupCommand)
            const setPasswordCommand = new AdminSetUserPasswordCommand({
                UserPoolId: userPoolId,
                Username: username,
                Password: password,
                Permanent: true
            })
            await cognito.send(setPasswordCommand)
            const addToGroup = new AdminAddUserToGroupCommand({
                UserPoolId: userPoolId,
                Username: username,
                GroupName: this.group.GroupName
            })
            await cognito.send(addToGroup)
            return new TestUserImpl(username)
        }
    }

    return {
        loadTestGroup: TestGroupImpl.loadTestGroup
    }
}

