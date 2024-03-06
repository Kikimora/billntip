// noinspection JSUnusedGlobalSymbols

import * as dotenv from "dotenv";
import * as upath from "upath";
import * as fs from "fs";
import * as pulumi from "@pulumi/pulumi";

dotenv.config();

import {userPool, userPoolClient, userPoolDomain as upd} from "./cognito";
import {dataTable as dt, sessionsTable, locksTable as lt} from "./dynamodb";
import {apiGateway, apiUrl} from "./api";
import {bucket} from "./s3";

// Outputs
export {apiUrl}
export const apiId = apiGateway.id
export const dataTable = dt.name
export const locksTable = lt.name
export const sessionTable = sessionsTable.name
export const userPoolId = userPool.id
export const userPoolDomain = upd.domain
export const userPoolClientId = userPoolClient.id
export const bucketName = bucket.id

const outputsCachePath = upath.join(__dirname, "..", "out", "outputs.json")
pulumi.all({...exports}).apply(x => {
    fs.writeFileSync(outputsCachePath, JSON.stringify(x))
    console.log("Outputs written to ../out/outputs.json")
})
