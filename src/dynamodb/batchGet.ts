import * as ddb from "@aws-sdk/client-dynamodb";
import {marshall} from "@aws-sdk/util-dynamodb";
import {KeySchema, TableType, SchemaType, ProjectionGenerator} from "./schema";
import {prepareCommand} from "./util";
import _ from "lodash";

/**
 * DynamoDb {@link ddb.KeysAndAttributes} for a given {@link Table}
 */
interface BatchGetItem<Table> {
    /**
     * See {@link ddb.BatchGetItemInput.Key}
     */
    keys: Array<SchemaType<KeySchema<Table>>>,
    /**
     * Function generating {@link ddb.BatchGetItemInput.ProjectionExpression}
     */
    projection?: ProjectionGenerator<Table>
    /**
     * See {@link ddb.BatchGetItemInput.ConsistentRead}
     */
    consistentRead?: boolean,
}

/**
 * Builds batch get operation.
 */
interface BatchGetBuilder {
    /**
     * Add batch of items to {@link ddb.BatchGetItemCommandInput}.
     * @param tbl - target table
     * @param item - items batch (see {@link ddb.BatchGetItemInput.RequestItems }
     */
    add<Table extends TableType<Table>>(tbl: Table, item: BatchGetItem<Table>): BatchGetBuilder

    /**
     * See {@link ddb.BatchGetItemCommandInput.ReturnConsumedCapacity}
     * @param capacity
     */
    returnConsumedCapacity(capacity: ddb.ReturnConsumedCapacity): BatchGetBuilder

    /**
     * Build {@link ddb.BatchGetItemCommandInput}
     */
    input(): ddb.BatchGetItemCommandInput

    /**
     * Build {@link ddb.BatchGetItemCommand}
     */
    command(): ddb.BatchGetItemCommand
}

/**
 * Create a builder for {@link ddb.BatchGetItemCommandInput} and {@link ddb.BatchGetItemCommand}
 */
export function batchGet(): BatchGetBuilder {
    const items: Record<string, ddb.KeysAndAttributes> = {}
    let returnConsumedCapacity: ddb.ReturnConsumedCapacity | undefined

    const builder: BatchGetBuilder = {
        add<T extends TableType<T>>(tbl: T, item: BatchGetItem<T>) {
            const {
                attributeNames,
                key,
                attr,
            } = prepareCommand(tbl, undefined);
            const {projection} = item
            items[tbl.name] = {
                Keys: item.keys.map(x => marshall(x)),
                ConsistentRead: item.consistentRead,
                ProjectionExpression: projection?.({key, attr}),
                ExpressionAttributeNames: !_.isEmpty(attributeNames) ? attributeNames : undefined,
            }
            return builder
        },
        returnConsumedCapacity(capacity: ddb.ReturnConsumedCapacity) {
            returnConsumedCapacity = capacity
            return builder
        },
        input() {
            return {
                RequestItems: items,
                ReturnConsumedCapacity: returnConsumedCapacity
            };
        },
        command() {
            return new ddb.BatchGetItemCommand(this.input())
        }
    }

    return builder
}
