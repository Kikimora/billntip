import {apiClient as api} from "./api-client";
import {frontendClient as frontend} from "./frontend-client";
import {userPool} from "./userpool";
import {userPoolDomain} from "@aws/cognito/domain";

export const pool = userPool

/**
 * Confidential Cognito API client for backend.
 */
export const apiClient = {
    id: api.id
}
/**
 * Public Cognito API client for frontend application.
 */
export const frontendClient = {
    id: frontend.id
}

export const domain = userPoolDomain.domain

export {tokenValidityInSeconds} from "./util"