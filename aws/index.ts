// noinspection JSUnusedGlobalSymbols
import * as dotenv from "dotenv";
import * as upath from "upath";
import * as fs from "fs";
import * as pulumi from "@pulumi/pulumi";

dotenv.config();

// Outputs
import {locksTable, sessionsTable, dataTable} from "./dynamodb"
import Cognito from "./cognito"
import {cognitoClients} from "./api"

export const dynamodb = {locksTable, sessionsTable, dataTable}
export const cognito = {
    ...Cognito,
    clients: cognitoClients
}
export {default as api} from "./api"
export * as s3 from "./s3"

const outputsCachePath = upath.join(__dirname, "resources.json")
pulumi.all({...exports}).apply(x => {
    fs.writeFileSync(outputsCachePath, JSON.stringify(x, null, 2))
    console.log("Outputs written to ./aws/resources.json")
})
