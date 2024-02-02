import * as dotenv from "dotenv";
import * as upath from "upath";
import * as fs from "fs";
import * as pulumi from "@pulumi/pulumi";

dotenv.config();

import {userPool, userPoolClient, userPoolDomain as upd} from "./users";
import {dataTable as dt, sessionsTable} from "./data";
import {apiUrl} from "./api";
import {bucket} from "./files";

// Outputs
export {apiUrl}
export const dataTable = dt.name
export const sessionTable = sessionsTable.name
export const userPoolId = userPool.id
export const userPoolDomain = upd.domain
export const userPoolClientId = userPoolClient.id
export const bucketName = bucket.id

const outputsCachePath = upath.join(__dirname, "..", "out", "outputs.json")
pulumi.all({apiUrl, dataTable, sessionTable, userPoolId, bucketName, userPoolClientId, userPoolDomain}).apply(x => {
    fs.writeFileSync(outputsCachePath, JSON.stringify(x))
    console.log("Outputs written to ../out/outputs.json")
})
