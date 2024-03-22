import userPool from "./userpool";
import userPoolDomain from "./domain";
import {appleIdp, facebookIdp, googleIdp} from "./idps";

export default {

    /**
     * Cognito user pool
     */
    userPool,
    /**
     * Cognito user pool domain
     */
    userPoolDomain,
    identityProviders: {
        apple: {
            name: appleIdp.providerName,
            urn: appleIdp.urn
        },
        facebook: {
            name: facebookIdp.providerName,
            urn: facebookIdp.urn
        },
        google: {
            name: googleIdp.providerName,
            urn: googleIdp.urn
        }
    }
}