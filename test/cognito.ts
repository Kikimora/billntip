import {
    AdminAddUserToGroupCommand,
    AdminCreateUserCommand,
    AdminDeleteUserCommand,
    AdminInitiateAuthCommand,
    AdminSetUserPasswordCommand, CognitoIdentityProvider,
    CreateGroupCommand,
    GetGroupCommand, GetUserCommandOutput,
    GroupType
} from "@aws-sdk/client-cognito-identity-provider";
import {createHmac} from 'crypto';
import {TokenEndpointResponse} from "@src/authorizer/oidc_tokens";
import {toSeconds} from "@app/util";
import shortUUID, {uuid} from "short-uuid";
import {Profile, SessionContext} from "@src/authorizer/types";
import * as jwt from "jsonwebtoken";
import _ from "lodash";
import {resources} from "@app/test/util";
import {internalError} from "@app/lambda";

const cognito = new CognitoIdentityProvider()
const password = "Qweqwe_1";

const shortUUIDGenerator = shortUUID(shortUUID.constants.flickrBase58)

const {cognito: {userPool: {id: UserPoolId}, clients: {api: {id: UserPoolClientId}}}} = resources()

/**
 * Return cached user pool and client configuration.
 */
export const fetchCognitoDetails = _.memoize(async function () {
    const {UserPool: userPool} = await cognito.describeUserPool({UserPoolId})
    const {UserPoolClient: userPoolClient} = await cognito.describeUserPoolClient({
        UserPoolId,
        ClientId: UserPoolClientId
    })
    if (userPoolClient === undefined) throw internalError("Cannot load user pool client details")
    if (userPool === undefined) throw internalError("Cannot load user pool details")

    return {
        clientSecret: userPoolClient.ClientSecret!,
        refreshTokenTtl: toSeconds(userPoolClient.RefreshTokenValidity!, userPoolClient.TokenValidityUnits?.RefreshToken!)
    }
})

export class TestUser {

    private tokens?: TokenEndpointResponse

    constructor(readonly username: string) {
    }

    async login() {
        const {clientSecret} = await fetchCognitoDetails()
        const hasher = createHmac('sha256', clientSecret);
        hasher.update(`${this.username}${UserPoolClientId}`);
        let output = hasher.digest('base64');

        const loginCommand = new AdminInitiateAuthCommand({
            UserPoolId,
            AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
            ClientId: UserPoolClientId,
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
            UserPoolId,
            Username: this.username
        })
        await cognito.send(deleteUserCommand)
    }
}

export class TestGroup {

    constructor(public readonly group: GroupType) {
    }

    private static _group?: Promise<TestGroup>

    public static async fetch() {
        return this._group ?? (this._group = fetchGroup())

        async function fetchGroup() {
            try {
                const getGroupCommand = new GetGroupCommand({
                    UserPoolId: UserPoolId,
                    GroupName: "Test"
                })
                const group = await cognito.send(getGroupCommand)
                return new TestGroup(group.Group!)
            } catch (e) {
                const createGroupCommand = new CreateGroupCommand({
                    UserPoolId: UserPoolId,
                    GroupName: "Test",
                    Description: "Group with test users"
                })
                const group = await cognito.send(createGroupCommand)
                return new TestGroup(group.Group!)
            }
        }
    }

    async createUniqueUser() {
        const username = `${shortUUIDGenerator.generate()}@mailinator.com`
        const signupCommand = new AdminCreateUserCommand({
            UserPoolId: UserPoolId,
            Username: username,
            MessageAction: "SUPPRESS",
            UserAttributes: [
                {Name: "email_verified", Value: "true"},
                {Name: "email", Value: username},
            ]
        })
        await cognito.send(signupCommand)
        const setPasswordCommand = new AdminSetUserPasswordCommand({
            UserPoolId: UserPoolId,
            Username: username,
            Password: password,
            Permanent: true
        })
        await cognito.send(setPasswordCommand)
        const addToGroup = new AdminAddUserToGroupCommand({
            UserPoolId: UserPoolId,
            Username: username,
            GroupName: this.group.GroupName
        })
        await cognito.send(addToGroup)
        return new TestUser(username)
    }
}

export interface TestSessionOptions {
    email?: string,
    profile?: Partial<Profile>
}

export function newSession(username: string, options?: TestSessionOptions): SessionContext {
    const private_key = 'private_key';
    const originJti = uuid()
    const access = {
        "origin_jti": originJti
    };
    const accessToken = jwt.sign(access, private_key, {algorithm: 'HS256'});
    const expiresIn = 3600;
    const profile = _.defaults(options?.profile, {
        "cognito:username": username,
        "cognito:groups": [],
        "email_verified": true,
        "email": options?.email ?? "email@example.com",
        "sub": username,
        token_use: "id",
        "aud": "",
        "auth_time": 1,
        "exp": 1,
        "iat": 1,
        "iss": "",
        "jti": "",
        "origin_jti": originJti
    });
    const idToken = jwt.sign(profile, private_key, {algorithm: 'HS256'});
    return {
        id: "SessionId:123",
        updated_at: Date.now(),
        access_token_json: access,
        access_token: accessToken,
        id_token_json: profile,
        id_token: idToken,
        access_token_expires_at: Date.now() / 1000 + expiresIn,
        session_expires_at: Date.now() / 1000 + expiresIn
    } satisfies SessionContext;
}