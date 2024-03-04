import * as ddb from "@aws-sdk/client-dynamodb";
import {marshall} from "@aws-sdk/util-dynamodb";
import {KeySchema, TableType, SchemaType, ProjectionGenerator} from "./schema";
import {prepareCommand} from "./util";
import _ from "lodash";

/**
 * DynamoDb {@link ddb.KeysAndAttributes} for a given {@link Table}
 */
interface TransactionGetItem<Table> {
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
interface TransactionGetBuilder {
    /**
     * Add batch of items to {@link ddb.TransactGetItemsInput}.
     * @param tbl - target table
     * @param item - items batch (see {@link ddb.TransactGetItemsInput.RequestItems }
     */
    add<Table extends TableType<Table>>(tbl: Table, item: TransactionGetItem<Table>): TransactionGetBuilder

    /**
     * See {@link ddb.TransactGetItemsInput.ReturnConsumedCapacity}
     * @param capacity
     */
    returnConsumedCapacity(capacity: ddb.ReturnConsumedCapacity): TransactionGetBuilder

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
export function transactGet(): TransactionGetBuilder {
    const items: ddb.TransactGetItem[] = []
    let returnConsumedCapacity: ddb.ReturnConsumedCapacity | undefined

    const builder: TransactionGetBuilder = {
        add<T extends TableType<T>>(tbl: T, item: TransactionGetItem<T>) {
            const dynamoKey = marshall(item.key);
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
                    ProjectionExpression: projection?.({key, attr}),
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
