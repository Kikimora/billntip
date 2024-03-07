import {pool, userPoolClient, userPoolDomain} from "./cognito";

export {pool}

export const client = {
    id: userPoolClient.id
}

export const domain = userPoolDomain.domain
