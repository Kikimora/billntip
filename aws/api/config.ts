import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
export const domain = config.get('domain');
export const region = config.get('aws:region');
