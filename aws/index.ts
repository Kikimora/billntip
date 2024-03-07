// noinspection JSUnusedGlobalSymbols
import * as dotenv from "dotenv";
import * as upath from "upath";
import * as fs from "fs";
import * as pulumi from "@pulumi/pulumi";

dotenv.config();

// Outputs
export * as dynamodb from "./dynamodb"
export * as api from "./api"
export * as cognito from "./cognito"
export * as s3 from "./s3"

const outputsCachePath = upath.join(__dirname, "..", "out", "outputs.json")
pulumi.all({...exports}).apply(x => {
    fs.writeFileSync(outputsCachePath, JSON.stringify(x))
    console.log("Outputs written to ../out/outputs.json")
})
