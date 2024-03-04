import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {unmarshall} from '@aws-sdk/util-dynamodb';
import {D, getCommand, SchemaType, table, updateCommand} from "../src/dynamodb";
import {TableSchema} from "../src/dynamodb/schema";

const dynamodb = new DynamoDBClient()

export function init(sessionsTable: string) {

    const Sessions = table(sessionsTable, {session_id: D.String} as const, {expires_at: D.Number} as const)

    return {
        async getSession(key: string) {
            const response = await dynamodb.send(getCommand(Sessions, {
                key: {session_id: key}
            }))
            return response.Item != null ? unmarshall(response.Item) : null
        },

        async updateSession(key: string, data: Partial<SchemaType<TableSchema<typeof Sessions>>>) {
            const response = await dynamodb.send(updateCommand(Sessions, {
                key: {session_id: key},
                return: "ALL_NEW",
                expression: (ctx) => ctx.set(data)
            }))
            return unmarshall(response.Attributes!)

        }

    }

}