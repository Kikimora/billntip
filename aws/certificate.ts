import * as aws from "@pulumi/aws";
import * as config from "./config"

export const regionalCertificate = aws.acm.Certificate.get("billntip-certificate", config.regionalCertificate)

const useast1 = new aws.Provider("aws-us-east-1", {
    region: "us-east-1",
    profile: config.profile
});
export const usEast1Certificate = aws.acm.Certificate.get("billntip-cf-certificate",
    config.useast1Certificate, {}, {provider: useast1})
