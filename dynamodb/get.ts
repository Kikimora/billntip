import * as ddb from "@aws-sdk/client-dynamodb";
import {marshall} from "@aws-sdk/util-dynamodb";
import {KeySchema, TableType, SchemaType, ExpressionGenerator, ProjectionGenerator} from "./schema";
import {prepareCommand} from "./util";
import _ from "lodash";

/**
 * DynamoDb {@link ddb.GetItemCommandInput} for a given {@link Table}
 */
interface GetCommand<Table> {
    /**
     * See {@link ddb.GetItemInput.Key}
     */
    key: SchemaType<KeySchema<Table>>,
    /**
     * Function generating {@link ddb.GetItemInput.ProjectionExpression}
     */
    projection?: ProjectionGenerator<Table>
    /**
     * See {@link ddb.GetItemInput.ConsistentRead}
     */
    consistentRead?: boolean,
    /**
     * See {@link ddb.GetItemInput.ReturnConsumedCapacity}
     */
    returnConsumedCapacity?: ddb.ReturnConsumedCapacity
}

/**
 * Create {@link ddb.GetItemCommandInput}.
 * @param tbl - target table
 * @param command - command parameters
 */
export function get<T extends TableType<T>>(tbl: T, command: GetCommand<T>): ddb.GetItemCommandInput {
    const dynamoKey = marshall(command.key);
    const {
        attributeNames,
        key,
        attr
    } = prepareCommand(tbl, {});
    const {projection} = command

    return {
        TableName: tbl.name,
        Key: dynamoKey,
        ProjectionExpression: projection?.({key, attr}),
        ExpressionAttributeNames: !_.isEmpty(attributeNames) ? attributeNames : undefined,
        ConsistentRead: command.consistentRead,
        ReturnConsumedCapacity: command.returnConsumedCapacity,
    };
}

/**
 * Create {@link ddb.GetItemCommand}.
 * @param tbl - target table
 * @param command - command parameters
 */
export function getCommand<T extends TableType<T>>(tbl: T, command: GetCommand<T>): ddb.GetItemCommand {
    return new ddb.GetItemCommand(get(tbl, command))
}
