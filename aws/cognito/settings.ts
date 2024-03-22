import * as pulumi from "@pulumi/pulumi";
import gateway from "@aws/api/gateway";

export const tokenValidity = {
    accessTokenValidity: 3600,
    refreshTokenValidity: 365,
    idTokenValidity: 3600,
    tokenValidityUnits: {
        idToken: "seconds",
        accessToken: "seconds",
        refreshToken: "days"
    }
}