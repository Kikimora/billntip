import _ from "lodash";
import * as ddb from "@aws-sdk/client-dynamodb";
import {marshall} from "@aws-sdk/util-dynamodb";
import Context, {TAttr, TKey, Values} from "./context";
import * as DDB from "./schema";

const MarshalOptions = {
    removeUndefinedValues: true
}

/**
 * Function generating a DynamoDB projection expression.
 *
 * <p>Projection expression is a string that identifies one or more attributes to retrieve from the table. These  attributes can include scalars, sets, or elements of a JSON document. The attributes in the expression must be separated by commas.</p>
 * <p>If no attribute names are specified, then all attributes are returned. If any of the requested attributes are not found, they do not appear in the result.</p>
 * <p>For more information, see <a href="https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.AccessingItemAttributes.html">Specifying Item Attributes</a> in the <i>Amazon DynamoDB Developer Guide</i>.</p>
 *
 * @return projection expression, or array of individual projection expressions which are joined with ", "
 */
export type ProjectionGenerator<Key, NonKey> = (context: {
    key: TKey<Key>,
    attr: TAttr<NonKey>
}) => string | string[] | undefined

interface HasProjection<Key = any, NonKey = any> {
    /**
     * Projection expression generator. See more [here]{@link ProjectionGenerator}.
     */
    projection?: ProjectionGenerator<Key, NonKey>
}

/**
 * Function generating a DynamoDB condition expression.
 *
 * A condition that must be satisfied in order for an operation to succeed. An expression can contain any of the following:
 * 1. Functions: `attribute_exists | attribute_not_exists | attribute_type | contains | begins_with | size`
 * 1. Comparison operators: `= | <> | < | > | <= | >= | BETWEEN | IN`
 * 1. Logical operators: <code>AND | OR | NOT</code>
 *
 * For more information see [`Condition Expressions`]{@link https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.SpecifyingConditions.html} in the <i>Amazon DynamoDB Developer Guide</i>.
 *
 * @return condition expression, or array of condition expressions which are joined using AND.
 */
export type ConditionGenerator<Key, NonKey, V> = (context: {
    key: TKey<Key>,
    attr: TAttr<NonKey>,
    ref: Values<V>
}) => string | string[] | undefined

export interface HasCondition<Key, NonKey, V = any> {
    /**
     * Condition expression generator. See more [here]{@link ConditionGenerator}.
     */
    condition?: ConditionGenerator<Key, NonKey, V>
    /**
     * An optional parameter that returns the item attributes if operation fails a condition check.
     */
    returnOnConditionFailure?: ddb.ReturnValuesOnConditionCheckFailure
}

export interface HasReturnValue<T extends ddb.ReturnValue = ddb.ReturnValue> {
    /**
     * Specify this option to get the item attributes as they appeared before or after the operation.
     * * `NONE` - If ReturnValues is not specified, or if its value is NONE, then nothing is returned. (This setting is the default for ReturnValues.)
     * * `ALL_OLD` - Returns all of the attributes of the item, as they appeared before the `UPDATE` operation.
     * * `UPDATED_OLD` - Returns only the updated attributes, as they appeared before the `UPDATE` operation.
     * * `ALL_NEW` - Returns all of the attributes of the item, as they appear after the `UPDATE` operation.
     * * `UPDATED_NEW` - Returns only the updated attributes, as they appear after the `UPDATE` operation.
     *
     * The values returned are strongly consistent.
     */
    return?: T
}

export interface HasConsumedCapacity {
    /**
     * Determines the level of detail about either provisioned or on-demand throughput consumption that is returned in the response:
     * * `INDEXES` - The response includes the aggregate ConsumedCapacity for the operation, together with ConsumedCapacity for each table and secondary index that was accessed.
     * Note that some operations, such as GetItem and BatchGetItem, do not access any indexes at all. In these cases, specifying INDEXES will only return ConsumedCapacity information for table(s).
     * * `TOTAL` - The response includes only the aggregate ConsumedCapacity for the operation.
     * * `NONE` - No ConsumedCapacity details are included in the response.
     */
    returnConsumedCapacity?: ReturnConsumedCapacity
}

export interface HasItemCollectionMetrics {
    /**
     * Determines whether item collection metrics are returned. If set to `SIZE`, the response includes statistics about item collections, if any, that were modified during the operation are returned in the response. If set to `NONE` (the default), no statistics are returned.
     */
    returnItemCollectionMetrics?: ddb.ReturnItemCollectionMetrics
}

/**
 * Function generating a DynamoDB update expression.
 *
 * @return update expression, or array of update expressions which are joined using "," or {@link UpdateExpression}.
 */
type UpdateGenerator<Key, NonKey, V> = (context: {
    key: TKey<Key>,
    attr: TAttr<NonKey>,
    ref: Values<V>
}) => string | string[] | UpdateExpression | undefined

/**
 * DynamoDB update expression.
 */
type UpdateExpression = {
    /**
     * SET statement, could be
     * 1. a string
     * 2. an attribute - value record
     * 3. array of above
     *
     * @example
     *
     * Table.update({
     *     values: { value1:1, value2: 2 }
     *     expression: ({key, attr, ref}) => ({
     *         set: [
     *          {
     *             [attr.attribute1]: ref('value1'),
     *             [attr.attribute2]: ref('value2')
     *          },
     *          `${attr.attribute2} = ${ref.val('inline value')}`
     *         ]
     *     })
     * })
     *
     */
    set?: string | Record<string, string> | (string | Record<string, string>)[],
    /**
     * ADD statement, a string or array of individual statements joined by ", "
     *
     * @example
     *
     * Table.update({
     *     values: { value1:1 }
     *     expression: ({key, attr, ref}) => ({
     *         add: [
     *          `${attr.someSet} ${ref.val('inline value')}`,
     *          `${attr.someSet} ${ref('value1')}`,
     *         ]
     *     })
     * })
     *
     */
    add?: string | string[],
    /**
     * REMOVE statement, a string or array of individual statements joined by ", "
     * @example
     * Table.update({
     *     expression: ({key, attr, ref}) => ({
     *         remove: [
     *          `${attr.attribute1}`,
     *          `${attr.attribute1}`,
     *         ]
     *     })
     * })
     */
    remove?: string | string[],
    /**
     * DELETE statement, a string or array of individual statements joined by ", "
     *
     * @example
     *
     * Table.update({
     *     values: { inc:1 }
     *     expression: ({key, attr, ref}) => ({
     *         delete: [
     *          `${attr.viewCount} ${ref('inc')}`,
     *          `${attr.myList} ${ref.val(userId)}`,
     *          `${attr.myList} ${ref.val(userId)}`,
     *         ]
     *     })
     * })
     *
     */
    delete?: string | string[],
}

/**
 * Function generating a DynamoDB query key condition expression.
 *
 * The key condition expression specifies the key values for items to be retrieved by the <code>Query</code> action. For more information on key condition expression see [official documentation]{@link https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.KeyConditionExpressions.html}.
 *
 * @return key condition expression, or array of key condition expressions which are joined using AND.
 */
export type KeyConditionGenerator<Key, V> = (context: {
    key: TKey<Key>,
    ref: Values<V>
}) => string | string[] | undefined

/**
 * Function generating a DynamoDB query filter condition expression.
 *
 * Filter expression is a string that contains conditions that DynamoDB applies after the <code>Query</code> operation, but before the data is returned to you. Items that do not satisfy the <code>FilterExpression</code> criteria are not returned.
 *
 * A <code>FilterExpression</code> does not allow key attributes. You cannot define a filter expression based on a partition key or a sort key.
 *
 * <p>A <code>FilterExpression</code> is applied after the items have already been read; the process of filtering does not consume any additional read capacity units.</p>
 *
 * <p>For more information, see <a href="https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.FilterExpression.html">Filter Expressions</a> in the <i>Amazon DynamoDB DeveloperGuide</i>.</p>
 *
 * @return filter expression, or array of filter expressions which are joined using AND.
 */
export type FilterConditionGenerator<Key, NonKey, V> = (context: {
    key: TKey<Key>,
    attr: TAttr<NonKey>,
    ref: Values<V>
}) => string | string[] | undefined

export interface HasConsistencySetting {
    /**
     * This setting determines the read consistency model. If set to true, the operation uses strongly consistent reads; if set to false, it uses eventually consistent reads.
     */
    consistentRead?: boolean,
}

/**
 * DynamoDb GetItem command.
 */
export interface GetOptions<Key, NonKey> extends HasProjection<Key, NonKey>, HasConsumedCapacity, HasConsistencySetting {
    key: Key,
}

/**
 * DynamoDb Delete Item command options.
 */
export interface DeleteOptions<Key = any, NonKey = any, Values = any> extends HasCondition<Key, NonKey, Key & Values>, HasReturnValue<"NONE" | "ALL_OLD">, HasConsumedCapacity, HasItemCollectionMetrics {
    /**
     * Primary key of the item to delete.
     */
    key: Key
}

export type ReturnConsumedCapacity = ddb.ReturnConsumedCapacity

/**
 * DynamoDb Put Item command options.
 */
export interface PutOptions<Key, NonKey, Values> extends HasReturnValue<"NONE" | "ALL_OLD">, HasCondition<Key, NonKey, DDB.Id<Key & NonKey & Values>>, HasConsumedCapacity, HasItemCollectionMetrics {
    /**
     * Key and Non-key attributes to put
     */
    item: DDB.Id<Key & NonKey>,
}

/**
 * DynamoDb {@link ddb.UpdateItemCommandInput} for a given {@link TableSchema}
 */
export interface UpdateOptions<Key, NonKey, Values> extends HasReturnValue, HasCondition<Key, NonKey, Key & Values>, HasItemCollectionMetrics, HasConsumedCapacity {
    /**
     * Primary key of the item to create or update.
     */
    key: Key,
    /**
     * Function generating {@link ddb.UpdateItemInput.UpdateExpression}
     */
    expression: UpdateGenerator<Key, NonKey, Key & Values>
}

export interface HasFilter<Key, NonKey, Values> {
    /**
     * The Select parameter determines the attributes to be returned in the result. You can choose to retrieve all
     * attributes from an item, specific attributes, the count of matching items, or attributes projected into an index.
     * The options include `ALL_ATTRIBUTES`, which returns all item attributes from the specified table or index;
     * `ALL_PROJECTED_ATTRIBUTES`, available only when querying an index; `COUNT`, which returns the number of matching
     * items without retrieving the actual items; and `SPECIFIC_ATTRIBUTES`, which returns only the attributes specified
     * in the [`projection`]{@link projection}.
     *
     * When using `SPECIFIC_ATTRIBUTES`, if querying or scanning a local secondary index, DynamoDB will fetch the
     * attributes from the parent table if they aren’t projected into the index, which may incur additional costs and
     * latency. For global secondary indexes, you can only request attributes projected into the index. If neither
     * Select nor ProjectionExpression is specified, DynamoDB defaults to ALL_ATTRIBUTES for tables and
     * `ALL_PROJECTED_ATTRIBUTES` for indexes.
     *
     * You cannot use both `select` and `projection` in a single request unless `select` is set to
     * `SPECIFIC_ATTRIBUTES`. If [`projection`]{@link projection} is used, the Select value must be `SPECIFIC_ATTRIBUTES`; otherwise,
     * an error will occur.
     *
     */
    select?: ddb.Select
    /**
     * Filter condition expression generator. See more [here]{@link FilterConditionGenerator}.
     */
    filter?: FilterConditionGenerator<Key, NonKey, Values | undefined>
    /**
     * See {@link ddb.QueryInput.Limit}
     */
    limit?: number

    /**
     * the primary key of the first item that this operation will evaluate. Use the value that was returned for LastEvaluatedKey in the previous operation.
     */
    startKey?: Key
}

/**
 * DynamoDb {@link ddb.QueryCommandInput} for a given {@link TableSchema}
 */
export interface QueryOptions<Key, NonKey, Values> extends HasProjection<Key, NonKey>, HasConsumedCapacity, HasFilter<Key, NonKey, Values>, HasConsistencySetting {
    /**
     * Key condition expression generator. See more [here]{@link KeyConditionGenerator}.
     */
    keyCondition: KeyConditionGenerator<Key, Values | undefined>

    /**
     * See {@link ddb.QueryInput.ScanIndexForward}
     */
    scanIndexForward?: boolean
}

/**
 * DynamoDb scan command.
 */
export interface ScanOptions<Key, NonKey, Values> extends HasProjection<Key, NonKey>, HasConsumedCapacity, HasFilter<Key, NonKey, Values>, HasConsistencySetting {
    /**
     * See {@link ddb.ScanInput.Segment}
     */
    segment?: number,
    /**
     * See {@link ddb.ScanInput.TotalSegments}
     */
    totalSegments?: number,
}

export class InputBuilder<Key, NonKey> {
    private context: Context<Key, NonKey>;

    constructor(
        public readonly name: string,
        public readonly schema: DDB.Schema,
        public readonly index?: string) {
        this.context = new Context<Key, NonKey>(schema, MarshalOptions)
    }

    get(options: GetOptions<Key, NonKey>): ddb.GetItemCommandInput {
        const {context, name} = this
        const dynamoKey = marshall(options.key, MarshalOptions);
        const {key, attr} = context.begin()
        try {
            const {projection} = options
            const proj = joinComma(projection?.({key, attr}))
            return {
                TableName: name,
                Key: dynamoKey,
                ProjectionExpression: proj,
                ConsistentRead: options.consistentRead,
                ReturnConsumedCapacity: options.returnConsumedCapacity,
                ExpressionAttributeNames: context.attributes
            }
        } finally {
            context.end()
        }
    }


    /**
     * Create {@link ddb.PutItemCommandInput}.
     * @param options - command options
     * @param values - command values
     */
    put<V>(options: PutOptions<Key, NonKey, V>, values?: V): ddb.PutItemCommandInput {
        const {name, context} = this
        const dynamoItem = marshall({...options.item}, MarshalOptions)
        const cmdValues = {...values, ...options.item} as V & NonKey & Key
        const ctx = context.begin(cmdValues, dynamoItem)
        const {condition} = options
        const cond = joinAnd(condition?.(ctx))
        return {
            TableName: name,
            Item: dynamoItem,
            ConditionExpression: cond,
            ExpressionAttributeValues: context.values,
            ExpressionAttributeNames: context.attributes,
            ReturnValues: options.return,
            ReturnValuesOnConditionCheckFailure: options.returnOnConditionFailure,
            ReturnConsumedCapacity: options.returnConsumedCapacity,
            ReturnItemCollectionMetrics: options.returnItemCollectionMetrics
        };
    }


    /**
     * Create update command.
     * @param options - command options
     * @param values - command values
     */
    update<V>(options: UpdateOptions<Key, NonKey, V>, values?: V): ddb.UpdateItemCommandInput {
        const {name, context} = this
        const itemKey = options.key
        const dynamoKey = marshall(itemKey, MarshalOptions)
        const value = {...values, ...itemKey} as V & Key
        const ctx = context.begin(value, dynamoKey)
        try {
            const {expression, condition} = options
            const update = updateExpression(expression?.(ctx))
            const cond = joinAnd(condition?.(ctx))
            return {
                TableName: name,
                Key: dynamoKey,
                UpdateExpression: update,
                ConditionExpression: cond,
                ExpressionAttributeValues: context.values,
                ExpressionAttributeNames: context.attributes,
                ReturnValuesOnConditionCheckFailure: options.returnOnConditionFailure,
                ReturnValues: options.return,
                ReturnConsumedCapacity: options.returnConsumedCapacity,
                ReturnItemCollectionMetrics: options.returnItemCollectionMetrics,
            };
        } finally {
            context.end()
        }
    }

    /**
     * Create delete command.
     * @param options - command options
     * @param values - command values
     */
    delete<V>(options: DeleteOptions<Key, NonKey, V>, values?: V): ddb.DeleteItemCommandInput {
        const {context, name} = this
        const itemKey = options.key
        const dynamoKey = marshall(itemKey, MarshalOptions)
        const cmdValues = {...values, ...itemKey} as V & Key
        const ctx = context.begin(cmdValues, dynamoKey)

        try {
            const {condition} = options
            const cond = joinAnd(condition?.(ctx))
            return {
                TableName: name,
                Key: dynamoKey,
                ConditionExpression: cond,
                ReturnValues: options.return,
                ReturnValuesOnConditionCheckFailure: options.returnOnConditionFailure,
                ReturnItemCollectionMetrics: options.returnItemCollectionMetrics,
                ReturnConsumedCapacity: options.returnConsumedCapacity,
                ExpressionAttributeNames: context.attributes,
                ExpressionAttributeValues: context.values
            };
        } finally {
            context.end()
        }
    }

    /**
     * Create query command input.
     * @param command - command parameters
     * @param values - command options
     */
    query<V>(command: QueryOptions<Key, NonKey, V>, values?: V): ddb.QueryCommandInput {
        const {name, index, context} = this
        const ctx = context.begin(values)

        try {
            const {keyCondition, filter, projection} = command
            const keyConditionExpression = joinAnd(keyCondition?.(ctx))
            const filterExpression = joinAnd(filter?.(ctx))
            const projectionExpression = joinComma(projection?.(ctx))
            return {
                TableName: name,
                IndexName: index,
                KeyConditionExpression: keyConditionExpression,
                ProjectionExpression: projectionExpression,
                FilterExpression: filterExpression,
                Select: command.select,
                Limit: command.limit,
                ExclusiveStartKey: command.startKey !== undefined ? marshall(command.startKey, MarshalOptions) : undefined,
                ScanIndexForward: command.scanIndexForward,
                ConsistentRead: command.consistentRead,
                ReturnConsumedCapacity: command.returnConsumedCapacity,
                ExpressionAttributeNames: context.attributes,
                ExpressionAttributeValues: context.values,
            };
        } finally {
            context.end()
        }
    }

    /**
     * Create scan command.
     * @param command - command parameters
     * @param values - command options
     */
    scan<V>(command: ScanOptions<Key, NonKey, V>, values?:V): ddb.ScanCommandInput {
        const {name, index, context} = this
        const ctx = context.begin(values)

        try {
            let {filter, projection} = command
            const projectionExpression = joinComma(projection?.(ctx))
            const filterExpression = joinAnd(filter?.(ctx))
            const exclusiveStartKey = command.startKey !== undefined ? marshall(command.startKey, MarshalOptions) : undefined;
            return {
                TableName: name,
                IndexName: index,
                ProjectionExpression: projectionExpression,
                FilterExpression: filterExpression,
                Select: command.select,
                Limit: command.limit,
                ExclusiveStartKey: exclusiveStartKey,
                Segment: command.segment,
                TotalSegments: command.totalSegments,
                ConsistentRead: command.consistentRead,
                ReturnConsumedCapacity: command.returnConsumedCapacity,
                ExpressionAttributeNames: context.attributes,
                ExpressionAttributeValues: context.values,
            };
        } finally {
            context.end()
        }
    }

    transactWrite(tx: TransactWriteBuilder): TableTransactWrite<Key, NonKey> {
        const {context, name} = this
        return new TableTransactWrite(tx, context, name)
    }

    transactGet(tx: TransactGetBuilder): TableTransactGet<Key, NonKey> {
        const {context, name} = this
        return new TableTransactGet(tx, context, name)
    }

    batchWrite(tx: BatchWriteBuilder): TableBatchWrite<Key, NonKey> {
        const {name} = this
        return new TableBatchWrite(tx, name)
    }

    batchGet(tx: BatchGetBuilder): TableBatchGet<Key, NonKey> {
        const {context, name} = this
        return new TableBatchGet(tx, context, name)
    }
}

/**
 * DynamoDb Batch Get Items command options.
 */
export interface BatchGetItemOptions<Key, NonKey> extends HasProjection<Key, NonKey>, HasConsistencySetting {
    /**
     * The primary key attribute values that define the items and the attributes associated with the items.
     */
    keys: Key[],
}

export interface BatchGetBuilder {
    set(table: string, kv: ddb.KeysAndAttributes): void
}

export class TableBatchGet<Key, NonKey> {

    constructor(private readonly builder: BatchGetBuilder,
                private readonly context: Context<Key, NonKey>,
                private readonly name: string) {
    }

    /**
     * Add new item to the batch.
     * @param options - batch options
     */
    get(options: BatchGetItemOptions<Key, NonKey>) {
        const {context, name, builder} = this
        const keys = options.keys
        const ctx = context.begin()
        try {
            const {projection} = options
            const projectionExpression = joinComma(projection?.(ctx))
            builder.set(name, {
                Keys: keys.map(x => marshall(x, MarshalOptions)),
                ConsistentRead: options.consistentRead,
                ProjectionExpression: projectionExpression,
                ExpressionAttributeNames: context.attributes
            })
        } finally {
            context.end()
        }
    }
}


export type BatchWriteItem<Key, Item> = BatchPutItem<Key & Item> | BatchDeleteItem<Key>

/**
 * Request to put an item into the table (see {@link ddb.PutRequest}).
 */
interface BatchPutItem<T> {
    /**
     * Indicate delete request.
     */
    action: "put",
    /**
     * Item to put
     */
    item: T,
}

/**
 * Request to delete an item from the table (see {@link ddb.DeleteRequest}).
 */
interface BatchDeleteItem<Key> {
    /**
     * Indicate delete request.
     */
    action: "delete",
    /**
     * Primary key of the item to delete.
     */
    key: Key
}

export interface BatchWriteBuilder {
    append(name: string, request: ddb.WriteRequest): void
}

export class TableBatchWrite<Key, Item> {

    constructor(private readonly builder: BatchWriteBuilder,
                private readonly name: string) {
    }

    /**
     * Add items to the batch.
     */
    add(items: BatchWriteItem<Key, Item>[]) {
        for (const x of items) {
            switch (x.action) {
                case 'put':
                    this.put(x.item)
                    break
                case 'delete':
                    this.delete(x.key)
                    break
            }
        }
    }

    /**
     * Schedule items for update.
     */
    put(item: Key & Item) {
        const {name, builder} = this
        builder.append(name, {
            PutRequest: {
                Item: marshall(item, MarshalOptions)
            }
        })
        return this
    }

    /**
     * Schedule items for deletion
     */
    delete(itemKey: Key) {
        const {name, builder} = this
        builder.append(name, {
            DeleteRequest: {
                Key: marshall(itemKey, MarshalOptions)
            }
        })
        return this
    }
}


/**
 * DynamoDb {@link ddb.KeysAndAttributes} for a given {@link TableSchema}
 */
export interface TransactGetItem<Key, NonKey> extends HasProjection<Key, NonKey> {
    /**
     * Primary key of the item to get.
     */
    key: Key,
}

export interface TransactGetBuilder {
    addItem(item: ddb.TransactGetItem): number
}

export class TableTransactGet<Key, NonKey> {
    private items: number[] = []

    constructor(private readonly builder: TransactGetBuilder,
                private readonly context: Context<Key, NonKey>,
                private readonly name: string) {
    }

    /**
     * Add get item transaction step.
     */
    get(item: TransactGetItem<Key, NonKey>) {
        const {name, context, builder} = this
        const itemKey = item.key
        const dynamoKey = marshall(itemKey, MarshalOptions)
        const ctx = context.begin()
        try {
            const {projection} = item
            const projectionExpression = joinComma(projection?.(ctx))
            const idx = builder.addItem({
                Get: {
                    TableName: name,
                    Key: dynamoKey,
                    ProjectionExpression: projectionExpression,
                    ExpressionAttributeNames: context.attributes
                }
            })
            this.items.push(idx)
        } finally {
            context.end()
        }

        return this
    }

    failures(e: TransactionCanceledException) {
        return pickErrors(e, this.items)
    }
}


/**
 * Defines {@link ddb.TransactWriteItem} for a {@link ddb.TransactWriteItemsCommand}
 */
export type TransactWriteItem<Key, NonKey, Values = any> =
    TransactPutItem<Key, NonKey, Values>
    | TransactUpdateItem<Key, NonKey, Values>
    | TransactDeleteItem<Key, NonKey, Values>
    | TransactCheckItem<Key, NonKey, Values>

/**
 * Request to put an item into the table (see {@link ddb.Put}).
 */
export interface TransactPutItem<Key, NonKey, Values> {
    /**
     * Indicate put request.
     */
    action: "put",
    /**
     * Item to put
     */
    item: DDB.Id<Key & NonKey>,
    /**
     * Condition expression generator. See more [here]{@link ConditionGenerator}.
     */
    condition?: ConditionGenerator<Key, NonKey, DDB.Id<Key & NonKey & Values>>
    /**
     * Use returnOnConditionFailure to get the item attributes if the `PUT` condition fails. The valid values are: `NONE` and `ALL_OLD`.
     */
    returnOnConditionFailure?: ddb.ReturnValuesOnConditionCheckFailure
}

/**
 * Request to put an item into the table (see {@link ddb.Update}).
 */
export interface TransactUpdateItem<Key, NonKey, Values> {
    /**
     * Indicate put request.
     */
    action: "update",
    /**
     * Primary key of the item to update.
     */
    key: Key,
    /**
     * Function generating {@link UpdateExpression}
     */
    expression: UpdateGenerator<Key, NonKey, Key & Values>
    /**
     * Condition expression generator. See more [here]{@link ConditionGenerator}.
     */
    condition?: ConditionGenerator<Key, NonKey, Key & Values>
    /**
     * Use returnOnConditionFailure to get the item attributes if the `UPDATE` condition fails. The valid values are: `NONE` and `ALL_OLD`.
     */
    returnOnConditionFailure?: ddb.ReturnValuesOnConditionCheckFailure
}

/**
 * Request to delete an item from the table (see {@link ddb.Delete}).
 */
export interface TransactDeleteItem<Key, NonKey, Values> {
    /**
     * Indicate delete request.
     */
    action: "delete",
    /**
     * Primary key of the item to delete.
     */
    key: Key,

    values?: Values
    /**
     * Condition expression generator. See more [here]{@link ConditionGenerator}.
     */
    condition?: ConditionGenerator<Key, NonKey, Key & Values>
    /**
     * Use returnOnConditionFailure to get the item attributes if the `DELETE` condition fails. The valid values are: `NONE` and `ALL_OLD`.
     */
    returnOnConditionFailure?: ddb.ReturnValuesOnConditionCheckFailure
}

/**
 * Request to put an item into the table (see {@link ddb.ConditionCheck}).
 */
export interface TransactCheckItem<Key, NonKey, Values> {
    /**
     * Indicate put request.
     */
    action: "check",
    /**
     * Primary key of the item to check.
     */
    key: Key,
    /**
     * Condition expression generator. See more [here]{@link ConditionGenerator}.
     */
    condition: ConditionGenerator<Key, NonKey, Key & Values>
    /**
     * Use returnOnConditionFailure to get the item attributes if the `CHECK` condition fails. The valid values are: `NONE` and `ALL_OLD`.
     */
    returnOnConditionFailure?: ddb.ReturnValuesOnConditionCheckFailure
}

export interface TransactWriteBuilder {
    addItem(item: ddb.TransactWriteItem): number
}

export class TableTransactWrite<Key, NonKey> {
    readonly items: number[] = []

    constructor(private readonly builder: TransactWriteBuilder,
                private readonly context: Context<Key, NonKey>,
                private readonly name: string) {
    }


    put<V>(txItem: Omit<TransactPutItem<Key, NonKey, V>, 'action'>, values?: V) {
        const {builder, context, name} = this
        const {item} = txItem
        const dynamoItem = marshall(item as Record<string, any>, MarshalOptions)
        const cmdValues = {...values, ...item} as DDB.Id<Key & NonKey & V>;
        const ctx = context.begin(cmdValues, dynamoItem)
        try {
            const {condition} = txItem
            const exp = joinAnd(condition?.(ctx))
            const idx = builder.addItem({
                Put: {
                    TableName: name,
                    Item: dynamoItem,
                    ConditionExpression: exp,
                    ReturnValuesOnConditionCheckFailure: txItem.returnOnConditionFailure,
                    ExpressionAttributeNames: context.attributes,
                    ExpressionAttributeValues: context.values,
                }
            })
            this.items.push(idx)
        } finally {
            context.end()
        }
        return this
    }

    update<V>(txItem: Omit<TransactUpdateItem<Key, NonKey, V>, 'action'>, values?: V) {
        const {builder, context, name} = this
        const itemKey = txItem.key
        const dynamoKey = marshall(itemKey, MarshalOptions)
        const cmdValues = {...values, ...itemKey} as Key & V;
        const ctx = context.begin(cmdValues, dynamoKey)
        try {
            const {expression, condition} = txItem
            const ue = updateExpression(expression?.(ctx))
            const cond = joinAnd(condition?.(ctx))
            const idx = builder.addItem({
                Update: {
                    TableName: name,
                    Key: dynamoKey,
                    UpdateExpression: ue,
                    ConditionExpression: cond,
                    ReturnValuesOnConditionCheckFailure: txItem.returnOnConditionFailure,
                    ExpressionAttributeNames: context.attributes,
                    ExpressionAttributeValues: context.values,
                }
            })
            this.items.push(idx)
        } finally {
            context.end()
        }
        return this
    }

    delete<V>(txItem: Omit<TransactDeleteItem<Key, NonKey, V>, 'action'>, values?: V) {
        const {builder, context, name} = this
        const itemKey = txItem.key
        const cmdValues = {...values, ...itemKey} as V & Key;
        const dynamoKey = marshall(itemKey, MarshalOptions)
        const ctx = context.begin(cmdValues, dynamoKey)
        try {
            const {condition} = txItem
            const cond = joinAnd(condition?.(ctx))
            const idx = builder.addItem({
                Delete: {
                    TableName: name,
                    Key: dynamoKey,
                    ConditionExpression: cond,
                    ReturnValuesOnConditionCheckFailure: txItem.returnOnConditionFailure,
                    ExpressionAttributeNames: context.attributes,
                    ExpressionAttributeValues: context.values,
                }
            })
            this.items.push(idx)
        } finally {
            context.end()
        }
        return this
    }

    check<V>(txItem: Omit<TransactCheckItem<Key, NonKey, V>, 'action'>, values?: V) {
        const {builder, context, name} = this
        const itemKey = txItem.key
        const cmdValues = {...values, ...itemKey} as V & Key;
        const dynamoKey = marshall(itemKey, MarshalOptions)
        const ctx = context.begin(cmdValues, dynamoKey)
        try {
            const {condition} = txItem
            const cond = joinAnd(condition?.(ctx))
            const idx = builder.addItem({
                ConditionCheck: {
                    TableName: name,
                    Key: dynamoKey,
                    ConditionExpression: cond,
                    ReturnValuesOnConditionCheckFailure: txItem.returnOnConditionFailure,
                    ExpressionAttributeNames: context.attributes,
                    ExpressionAttributeValues: context.values,
                }
            })
            this.items.push(idx)
        } finally {
            context.end()
        }
        return this
    }

    add<V>(item: TransactWriteItem<Key, NonKey, V>, values?:V) {
        switch (item.action) {
            case "check":
                return this.check(item, values)
            case "put":
                return this.put(item, values)
            case "update":
                return this.update(item, values)
            case "delete":
                return this.delete(item, values)
        }
    }

    failures(e: TransactionCanceledException) {
        return pickErrors(e, this.items)
    }
}

export interface CancellationReason<T = unknown> {
    /**
     * @public
     * <p>Status code for the result of the cancelled transaction.</p>
     */
    Code: string
    /**
     * @public
     * <p>Cancellation reason message description.</p>
     */
    Message: string
    /**
     * @public
     * <p>Item in the request which caused the transaction to get cancelled.</p>
     */
    Item: T
}

export interface TransactionCanceledException extends ddb.TransactionCanceledException {
    Outcomes: CancellationReason[]
}

export function isTransactionCancelled(e: unknown): e is TransactionCanceledException {
    return e instanceof ddb.TransactionCanceledException && 'Outcomes' in e
}

export function isTransactionConflict(e: CancellationReason): boolean {
    return e.Code === 'TransactionConflict'
}

function* pickErrors<T>(e: TransactionCanceledException, indices: number[]) {
    if (e.Outcomes === undefined) return
    for (let i = 0; i < indices.length; ++i) {
        const reason = e.Outcomes[indices[i]]
        if (reason !== undefined && reason.Code !== "None") {
            yield reason as CancellationReason<T>
        }
    }
}


function joinAnd(cond?: string | string[]): string | undefined {
    if (Array.isArray(cond)) {
        cond = cond.join(' AND ')
    }
    if (cond?.trim() === '') return undefined
    return cond
}

function joinComma(exp?: string | string[]): string | undefined {
    if (Array.isArray(exp)) {
        exp = exp.join(', ')
    }
    if (exp?.trim() === '') return undefined
    return exp
}

function updateExpression(exp?: string | string[] | UpdateExpression): string | undefined {
    if (exp === undefined) return undefined
    if (typeof exp === "string") return exp
    if (Array.isArray(exp))
        return _.compact(exp).join(", ")

    //deal with UpdateExpression
    const expression = []
    for (let [op, value] of Object.entries(exp)) {
        if (value === undefined) continue
        //op is SET, ADD, REMOVE or DELETE
        const statement = []
        if (typeof value === "string") {
            statement.push(value)
        } else if (Array.isArray(value)) {
            //(string | Record<string, string>)[]
            statement.push(..._.compact(value).map(value => {
                if (typeof value === "string") {
                    return value
                } else {
                    return processObject(value)
                }
            }))
        } else {
            //Record<string, string>
            statement.push(...processObject(value))
        }
        if (statement.length > 0)
            expression.push(op.toUpperCase() + " " + statement.join(", "))
    }

    const e = expression.join(' ')
    if (e.trim() === '') return undefined
    return e

    function processObject(exp: Record<string, string>) {
        return _(exp).map((value, attr) => `${attr} = ${value}`).value()
    }
}

