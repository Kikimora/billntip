import * as ddb from "@aws-sdk/client-dynamodb";
import {marshall} from "@aws-sdk/util-dynamodb";
import {TableType, TableSchema, TableAttributes, TableKey,} from "./schema";
import {MarshalOptions} from "./util";

/**
 * DynamoDb {@link ddb.WriteRequest} for a given {@link TableSchema}
 */
export type BatchWriteItem<T extends TableSchema> = BatchPutItem<T> | BatchDeleteItem<T>

/**
 * Request to put an item into the table (see {@link ddb.PutRequest}).
 */
interface BatchPutItem<T extends TableSchema> {
    /**
     * Indicate put request.
     */
    action: "put",
    /**
     * Table item key.
     */
    key: TableKey<T>
    /**
     * Non-key attributes.
     */
    item: TableAttributes<T>
}

/**
 * Request to delete an item from the table (see {@link ddb.DeleteRequest}).
 */
interface BatchDeleteItem<T extends TableSchema> {
    /**
     * Indicate delete request.
     */
    action: "delete",
    /**
     * Table item key.
     */
    key: TableKey<T>
}

export interface BatchWriteOptions {
    /**
     * See {@link ddb.BatchWriteItemInput.ReturnConsumedCapacity}
     */
    returnConsumedCapacity?: ddb.ReturnConsumedCapacity
    /**
     * See {@link ddb.BatchWriteItemInput.ReturnItemCollectionMetrics}
     */
    returnItemCollectionMetrics?: ddb.ReturnItemCollectionMetrics
}

/**
 * Builds batch write operation.
 */
export interface BatchWriteBuilder {
    /**
     * Add batch of items to {@link ddb.BatchWriteItemCommandInput}.
     * @param tbl - target table
     * @param items - the batch
     */
    add<T extends TableType<T>>(tbl: T, items: BatchWriteItem<T>[]): BatchWriteBuilder

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
     * Set operation options with a single call.
     * @param options - operation options
     */
    options(options: BatchWriteOptions): BatchWriteBuilder

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
        add<T extends TableType<T>>(tbl: T, items: BatchWriteItem<T>[]) {
            const batch = requests[tbl.name] ?? (requests[tbl.name] = [])
            batch.push(...items.map(x => {
                switch (x.action) {
                    case "put":
                        const data = {...x.key, ...x.item};
                        const item = marshall(data, MarshalOptions);
                        return {
                            PutRequest: {
                                Item: item
                            }
                        }
                    case "delete":
                        return {
                            DeleteRequest: {
                                Key: marshall(x.key, MarshalOptions)
                            }
                        }
                }
            }))
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
        options(options: BatchWriteOptions) {
            returnConsumedCapacity = options.returnConsumedCapacity
            returnItemCollectionMetrics = options.returnItemCollectionMetrics
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
