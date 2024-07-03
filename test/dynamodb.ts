import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {unmarshall} from '@aws-sdk/util-dynamodb';
import {Type, getCommand, table, updateCommand, TableItem} from "@app/dynamodb";
import _ from "lodash";
import {resources} from "@app/test/util";

const dynamodb = new DynamoDBClient()

export function init(sessionsTable: string) {

    const Sessions = table(sessionsTable, {session_id: Type.String} as const, {expires_at: Type.Number} as const)

    return {
        async getSession(key: string) {
            const response = await dynamodb.send(getCommand(Sessions, {
                key: {session_id: key}
            }))
            return response.Item != null ? unmarshall(response.Item) : null
        },

        async updateSession(key: string, data: Partial<TableItem<typeof Sessions>>) {
            const response = await dynamodb.send(updateCommand(Sessions, {
                key: {session_id: key},
                return: "ALL_NEW",
                expression: ({attr, val}) => ({
                    set: _(data)
                        .mapKeys((_1, key) => attr(key))
                        .mapValues(x => val(x))
                        .value()
                })
            }))
            return unmarshall(response.Attributes!)

        }

    }

}