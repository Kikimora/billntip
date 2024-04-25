import * as dotenv from 'dotenv';
import {Console} from 'node:console';
import {resources} from "@app/test/util";
import {configure} from "@app/diagnostics";

configure({triggers: {request: true}})

const e = dotenv.config()
if (e.error != null) throw e.error

const output = resources()
const tokenEndpoint = `https://${output.cognito.userPoolDomain.domain}.auth.eu-south-1.amazoncognito.com/oauth2/token`;
const oathIssuer = `https://cognito-idp.eu-south-1.amazonaws.com/${output.cognito.userPool.id}`
const SessionKey = 'SID'

process.env = {
    ...process.env,

    USERS_TABLE: output.dynamodb.usersTable.name,
    LOCKS_TABLE: output.dynamodb.locksTable.name,
    SESSION_TABLE: output.dynamodb.sessionsTable.name,

    USER_POOL_ID: output.cognito.userPool.id,
    OAUTH_CLIENT_ID: output.cognito.clients.api.id,
    OAUTH_ISSUER: oathIssuer,
    OAUTH_TOKEN_ENDPOINT: tokenEndpoint,
    POST_AUTH_REDIRECT_URL: "https://localhost",

    COOKIE_NAME: SessionKey,
    AUTHORIZER_CACHE_TTL: '120',

    AWS_REGION: 'eu-south-1',
}

global.console = new Console({
    stdout: process.stdout,
    stderr: process.stderr,
    inspectOptions: {
        depth: 5
    }
});

//Import this module after environment variables otherwise it fails to init.
import {Metrics} from "@src/authorizer/ctx";
//Metrics start a background process waiting for the Lambda termination which never happens in tests.
Metrics.stop()
