import * as ddb from "@aws-sdk/client-dynamodb";
import {marshall} from "@aws-sdk/util-dynamodb";
import {KeySchema, TableType, SchemaType, ProjectionGenerator} from "./schema";
import {MarshalOptions, prepareCommand} from "./util";
import _ from "lodash";

/**
 * DynamoDb {@link ddb.KeysAndAttributes} for a given {@link Table}
 */
interface TransactGetItem<Table> {
    /**
     * See {@link ddb.TransactGetItem.Get.Key}
     */
    key: SchemaType<KeySchema<Table>>,
    /**
     * Function generating {@link ddb.TransactGetItem.Get.ProjectionExpression}
     */
    projection?: ProjectionGenerator<Table>
}

/**
 * Builds batch get operation.
 */
export interface TransactGetBuilder {
    /**
     * Add batch of items to {@link ddb.TransactGetItemsInput}.
     * @param tbl - target table
     * @param item - items batch (see {@link ddb.TransactGetItemsInput.RequestItems }
     */
    add<Table extends TableType<Table>>(tbl: Table, item: TransactGetItem<Table>): TransactGetBuilder

    /**
     * See {@link ddb.TransactGetItemsInput.ReturnConsumedCapacity}
     * @param capacity
     */
    returnConsumedCapacity(capacity: ddb.ReturnConsumedCapacity): TransactGetBuilder

    /**
     * Build {@link ddb.TransactGetItemsInput}
     */
    input(): ddb.TransactGetItemsInput

    /**
     * Build {@link ddb.TransactGetItemsCommand}
     */
    command(): ddb.TransactGetItemsCommand
}


/**
 * Create a builder for {@link ddb.TransactGetItemsInput} and {@link ddb.TransactGetItemsCommand}
 */
export function transactGet(): TransactGetBuilder {
    const items: ddb.TransactGetItem[] = []
    let returnConsumedCapacity: ddb.ReturnConsumedCapacity | undefined

    const builder: TransactGetBuilder = {
        add<T extends TableType<T>>(tbl: T, item: TransactGetItem<T>) {
            const dynamoKey = marshall(item.key, MarshalOptions);
            const {
                attributeNames,
                key,
                attr,
            } = prepareCommand(tbl, undefined);
            const {projection} = item
            items.push({
                Get: {
                    TableName: tbl.name,
                    Key: dynamoKey,
                    ProjectionExpression: projection?.({key, attr})?.join(', '),
                    ExpressionAttributeNames: !_.isEmpty(attributeNames) ? attributeNames : undefined
                }
            })
            return builder
        },
        returnConsumedCapacity(capacity: ddb.ReturnConsumedCapacity) {
            returnConsumedCapacity = capacity
            return builder
        },
        input() {
            return {
                TransactItems: items,
                ReturnConsumedCapacity: returnConsumedCapacity
            };
        },
        command() {
            return new ddb.TransactGetItemsCommand(this.input())
        }
    }

    return builder
}
