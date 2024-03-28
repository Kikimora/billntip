import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
export const domain = config.get('domain');
const awsConfig = new pulumi.Config("aws");
export const region = awsConfig.get('region');
