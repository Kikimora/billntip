import {DynamoDBClient, GetItemCommand, UpdateItemCommand} from "@aws-sdk/client-dynamodb";
import {unmarshall, marshall} from '@aws-sdk/util-dynamodb';
import _ from "lodash";

const dynamodb = new DynamoDBClient()

export function init(sessionsTable: string) {

    return {
        async getSession(key: string) {
            const command = new GetItemCommand({
                TableName: sessionsTable,
                Key: marshall({'session_id': key})
            })
            const response = await dynamodb.send(command)
            return response.Item != null ? unmarshall(response.Item) : null
        },

        async updateSession(key: string, data: any) {
            const command = new UpdateItemCommand({
                TableName: sessionsTable,
                Key: marshall({'session_id': key}),
                AttributeUpdates: _.keys(data).reduce(function (update: any, key) {
                    update[key] = {Action: "PUT", Value: marshall(data[key])}
                    return update
                }, {}),
                ReturnValues: "ALL_NEW"
            })
            const response = await dynamodb.send(command)
            return unmarshall(response.Attributes!)

        }

    }

}