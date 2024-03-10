import * as ddb from "@aws-sdk/client-dynamodb";
import {marshall} from "@aws-sdk/util-dynamodb";
import {KeySchema, TableType, SchemaType, AttributesSchema,} from "./schema";

/**
 * DynamoDb {@link ddb.WriteRequest} for a given {@link Table}
 */
type BatchWriteItem<T> = BatchPutItem<T> | BatchDeleteItem<T>

/**
 * Request to put an item into the table (see {@link ddb.PutRequest}).
 */
interface BatchPutItem<T> {
    /**
     * Indicate put request.
     */
    action: "put",
    /**
     * Table item key.
     */
    key: SchemaType<KeySchema<T>>
    /**
     * Non-key attributes.
     */
    item: Partial<SchemaType<AttributesSchema<T>>>
}

/**
 * Request to delete an item from the table (see {@link ddb.DeleteRequest}).
 */
interface BatchDeleteItem<T> {
    /**
     * Indicate delete request.
     */
    action: "delete",
    /**
     * Table item key.
     */
    key: SchemaType<KeySchema<T>>
}

/**
 * Builds batch write operation.
 */
interface BatchWriteBuilder {
    /**
     * Add batch of items to {@link ddb.BatchWriteItemCommandInput}.
     * @param tbl - target table
     * @param items - the batch
     */
    add<Table extends TableType<Table>>(tbl: Table, items: BatchWriteItem<Table>[]): BatchWriteBuilder

    /**
     * See {@link ddb.BatchWriteItemInput.ReturnConsumedCapacity}
     * @param capacity - consumed capacity setting
     */
    returnConsumedCapacity(capacity: ddb.ReturnConsumedCapacity): BatchWriteBuilder

    /**
     * See {@link ddb.BatchWriteItemInput.ReturnItemCollectionMetrics}
     * @param metrics - item collection metric setting
     */
    returnItemCollectionMetrics(metrics: ddb.ReturnItemCollectionMetrics): BatchWriteBuilder

    /**
     * Build {@link ddb.BatchWriteItemCommandInput}
     */
    input(): ddb.BatchWriteItemCommandInput

    /**
     * Build {@link ddb.BatchWriteItemCommand}
     */
    command(): ddb.BatchWriteItemCommand
}

/**
 * Create a builder for {@link ddb.BatchWriteItemCommandInput} and {@link ddb.BatchWriteItemCommand}
 */
export function batchWrite(): BatchWriteBuilder {
    let requests: Record<string, ddb.WriteRequest[]> = {};
    let returnConsumedCapacity: ddb.ReturnConsumedCapacity | undefined;
    let returnItemCollectionMetrics: ddb.ReturnItemCollectionMetrics | undefined;

    return {
        add<Table extends TableType<Table>>(tbl: Table, items: BatchWriteItem<Table>[]) {
            requests[tbl.name] = items.map(x => {
                switch (x.action) {
                    case "put":
                        return {
                            PutRequest: {
                                Item: marshall({...x.key, ...x.item})
                            }
                        }
                    case "delete":
                        return {
                            DeleteRequest: {
                                Key: marshall(x.key)
                            }
                        }
                }
            })
            return this
        },
        returnConsumedCapacity(capacity: ddb.ReturnConsumedCapacity) {
            returnConsumedCapacity = capacity
            return this
        },
        returnItemCollectionMetrics(metrics: ddb.ReturnItemCollectionMetrics) {
            returnItemCollectionMetrics = metrics
            return this
        },
        input() {
            return {
                RequestItems: requests,
                ReturnConsumedCapacity: returnConsumedCapacity,
                ReturnItemCollectionMetrics: returnItemCollectionMetrics
            }
        },
        command() {
            return new ddb.BatchWriteItemCommand(this.input())
        }
    }
}
