import * as ddb from "@aws-sdk/client-dynamodb";
import {marshall, unmarshall, unmarshallOptions} from "@aws-sdk/util-dynamodb";
import _ from "lodash";
import Context, {ItemAttributes, KeyAttributes, Values} from "./command-context";
import {schema} from "./schema";
import {internalError} from "@app/lambda";
import {errorWithContext} from "@app/diagnostics";

const MarshalOptions = {
    removeUndefinedValues: true
}

/**
 * Create DynamoDB object providing function to query and update DynamoDB tables.
 * @param options - dynamodb options
 */
export default function (options?: DynamoDBOptions) {
    return new DynamoDB(options)
}

/**
 * Function generating a DynamoDB projection expression.
 *
 * <p>Projection expression is a string that identifies one or more attributes to retrieve from the table. These  attributes can include scalars, sets, or elements of a JSON document. The attributes in the expression must be separated by commas.</p>
 * <p>If no attribute names are specified, then all attributes are returned. If any of the requested attributes are not found, they do not appear in the result.</p>
 * <p>For more information, see <a href="https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.AccessingItemAttributes.html">Specifying Item Attributes</a> in the <i>Amazon DynamoDB Develope Guide</i>.</p>
 *
 * @return projection expression, or array of individual projection expressions which are joined with ", "
 */
type ProjectionGenerator<T extends schema.TableSchema> = (context: {
    key: KeyAttributes<T>,
    attr: ItemAttributes<T>
}) => string | string[] | undefined

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
type ConditionGenerator<T extends schema.TableSchema, V> = (context: {
    key: KeyAttributes<T>,
    attr: ItemAttributes<T>,
    ref: Values<V>
}) => string | string[] | undefined

/**
 * Function generating a DynamoDB update expression.
 *
 * @return update expression, or array of update expressions which are joined using "," or {@link UpdateExpression}.
 */
type UpdateGenerator<T extends schema.TableSchema, V> = (context: {
    key: KeyAttributes<T>,
    attr: ItemAttributes<T>,
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
type KeyConditionGenerator<T extends schema.TableSchema, V> = (context: {
    key: KeyAttributes<T>,
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
type FilterConditionGenerator<T extends schema.TableSchema, V> = (context: {
    attr: ItemAttributes<T>,
    ref: Values<V>
}) => string | string[] | undefined

/**
 * DynamoDb GetItem command.
 */
interface GetOptions<T extends schema.TableSchema> {
    /**
     * Projection expression generator. See more [here]{@link ProjectionGenerator}.
     */
    projection?: ProjectionGenerator<T>
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
 * DynamoDb {@link ddb.DeleteItemCommandInput} for a given {@link TableSchema}
 */
interface DeleteOptions<T extends schema.TableSchema, V> {
    /**
     * Context values to be used in expressions generated by {@link condition}.
     */
    values?: V,
    /**
     * Condition expression generator. See more [here]{@link ConditionGenerator}.
     */
    condition?: ConditionGenerator<T, schema.KeyType<T> & V>
    /**
     * Specify this option to get the item attributes as they appeared before the operation.
     * * `NONE` - If ReturnValues is not specified, or if its value is NONE, then nothing is returned. (This setting is the default for ReturnValues.)
     * * `ALL_OLD` - Returns all of the attributes of the item, as they appeared before the `DELETE` operation.
     *
     * The values returned are strongly consistent.
     */
    return?: ddb.ReturnValue
    /**
     * An optional parameter that returns the item attributes for a DeleteItem operation that failed a condition check.
     */
    returnOnConditionFailure?: ddb.ReturnValuesOnConditionCheckFailure;
    /**
     * Determines whether item collection metrics are returned. If set to `SIZE`, the response includes statistics about item collections, if any, that were modified during the operation are returned in the response. If set to `NONE` (the default), no statistics are returned.
     */
    returnItemsCollectionMetrics?: ddb.ReturnItemCollectionMetrics
    /**
     * Determines the level of detail about either provisioned or on-demand throughput consumption that is returned in the response For more information see {@link ReturnConsumedCapacity}.
     */
    returnConsumedCapacity?: ReturnConsumedCapacity
}

/**
 * Determines the level of detail about either provisioned or on-demand throughput consumption that is returned in the response:
 * * `INDEXES` - The response includes the aggregate ConsumedCapacity for the operation, together with ConsumedCapacity for each table and secondary index that was accessed.
 * Note that some operations, such as GetItem and BatchGetItem, do not access any indexes at all. In these cases, specifying INDEXES will only return ConsumedCapacity information for table(s).
 * * `TOTAL` - The response includes only the aggregate ConsumedCapacity for the operation.
 * * `NONE` - No ConsumedCapacity details are included in the response.
 */
type ReturnConsumedCapacity = ddb.ReturnConsumedCapacity

/**
 * DynamoDb {@link ddb.PutItemCommandInput} for a given {@link TableSchema}
 */
interface PutOptions<T extends schema.TableSchema, V> {
    /**
     * A non-key portion of the item to cretae or update.
     */
    item: schema.AttributesType<T>,
    /**
     * Context values to be used in expressions generated by {@link condition}.
     */
    values?: V
    /**
     * Condition expression generator. See more [here]{@link ConditionGenerator}.
     */
    condition?: ConditionGenerator<T, schema.KeyType<T> & schema.AttributesType<T> & V>
    /**
     * Specify this option to get the item attributes as they appeared before the operation.
     * * `NONE` - If ReturnValues is not specified, or if its value is NONE, then nothing is returned. (This setting is the default for ReturnValues.)
     * * `ALL_OLD` - Returns all of the attributes of the item, as they appeared before the `PUT` operation.
     *
     * The values returned are strongly consistent.
     */
    return?: ddb.ReturnValue
    /**
     * An optional parameter that returns the item attributes for a `PUT` operation that failed a condition check.
     */
    returnOnConditionFailure?: ddb.ReturnValuesOnConditionCheckFailure
    /**
     * Determines the level of detail about either provisioned or on-demand throughput consumption that is returned in the response For more information see {@link ReturnConsumedCapacity}.
     */
    returnConsumedCapacity?: ReturnConsumedCapacity
    /**
     * Determines whether item collection metrics are returned. If set to `SIZE`, the response includes statistics about item collections, if any, that were modified during the operation are returned in the response. If set to `NONE` (the default), no statistics are returned.
     */
    returnCollectionMetrics?: ddb.ReturnItemCollectionMetrics
}


/**
 * DynamoDb {@link ddb.UpdateItemCommandInput} for a given {@link TableSchema}
 */
interface UpdateOptions<T extends schema.TableSchema, V> {
    /**
     * Context values to be used in expressions generated by {@link expression} or {@link condition}.
     */
    values?: V,
    /**
     * Function generating {@link ddb.UpdateItemInput.UpdateExpression}
     */
    expression?: UpdateGenerator<T, schema.KeyType<T> & V>
    /**
     * Condition expression generator. See more [here]{@link ConditionGenerator}.
     */
    condition?: ConditionGenerator<T, schema.KeyType<T> & V>
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
    return?: ddb.ReturnValue
    /**
     * An optional parameter that returns the item attributes for an `UPDATE` operation that failed a condition check.
     */
    returnOnConditionFailure?: ddb.ReturnValuesOnConditionCheckFailure
    /**
     * Determines the level of detail about either provisioned or on-demand throughput consumption that is returned in the response For more information see {@link ReturnConsumedCapacity}.
     */
    returnConsumedCapacity?: ReturnConsumedCapacity
    /**
     * Determines whether item collection metrics are returned. If set to `SIZE`, the response includes statistics about item collections, if any, that were modified during the operation are returned in the response. If set to `NONE` (the default), no statistics are returned.
     */
    returnCollectionMetrics?: ddb.ReturnItemCollectionMetrics
}


/**
 * DynamoDb {@link ddb.QueryCommandInput} for a given {@link TableSchema}
 */
interface QueryOptions<T extends schema.TableSchema, V> {
    /**
     * Context values to be used in expressions generated by {@link keyCondition} or {@link filter}.
     */
    values?: V
    /**
     * Key condition expression generator. See more [here]{@link KeyConditionGenerator}.
     */
    keyCondition?: KeyConditionGenerator<T, V | undefined>
    /**
     * Filter condition expression generator. See more [here]{@link FilterConditionGenerator}.
     */
    filter?: FilterConditionGenerator<T, V | undefined>
    /**
     * Projection expression generator. See more [here]{@link ProjectionGenerator}.
     */
    projection?: ProjectionGenerator<T>
    /**
     * See {@link ddb.QueryInput.Select}
     */
    select?: ddb.Select
    /**
     * See {@link ddb.QueryInput.Limit}
     */
    limit?: number
    /**
     * See {@link ddb.QueryInput.ScanIndexForward}
     */
    scanIndexForward?: boolean
    /**
     * See {@link ddb.QueryInput.ConsistentRead}
     */
    consistentRead?: boolean
    /**
     * Determines the level of detail about either provisioned or on-demand throughput consumption that is returned in the response For more information see {@link ReturnConsumedCapacity}.
     */
    returnConsumedCapacity?: ReturnConsumedCapacity
}

/**
 * DynamoDb scan command.
 */
interface ScanOptions<T extends schema.TableSchema, V> {
    /**
     * Context values to be used in expressions generated by {@link filter}.
     */
    values?: V
    /**
     * Filter condition expression generator. See more [here]{@link FilterConditionGenerator}.
     */
    filter?: FilterConditionGenerator<T, V | undefined>
    /**
     * Projection expression generator. See more [here]{@link ProjectionGenerator}.
     */
    projection?: ProjectionGenerator<T>
    /**
     * See {@link ddb.ScanInput.Select}
     */
    select?: ddb.Select
    /**
     * See {@link ddb.ScanInput.Limit}
     */
    limit?: number
    /**
     * See {@link ddb.ScanInput.Segment}
     */
    segment?: number,
    /**
     * See {@link ddb.ScanInput.TotalSegments}
     */
    totalSegments?: number,
    /**
     * See {@link ddb.ScanInput.ConsistentRead}
     */
    consistentRead?: boolean
    /**
     * Determines the level of detail about either provisioned or on-demand throughput consumption that is returned in the response For more information see {@link ReturnConsumedCapacity}.
     */
    returnConsumedCapacity?: ReturnConsumedCapacity
}

class CommandBuilder<T extends schema.TableSchema, Key extends schema.KeyType<T> = schema.KeyType<T>> {
    private context: Context<T>;

    constructor(public readonly table: T) {
        this.context = new Context(table.key, table.attributes, MarshalOptions)
    }

    get(itemKey: Key, options: GetOptions<T> = {}): ddb.GetItemCommandInput {
        const {context, table: {name}} = this
        const dynamoKey = marshall(itemKey, MarshalOptions);
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
     * @param itemKey - primary key of the item to create or update.
     * @param options - command options
     */
    put<V>(itemKey: Key, options: PutOptions<T, V>): ddb.PutItemCommandInput {
        const {table: {name}, context} = this
        const dynamoItem = marshall({...options.item, ...itemKey}, MarshalOptions)
        const values = {...options.values, ...options.item, ...itemKey} as V & schema.AttributesType<T> & Key
        const ctx = context.begin(values, dynamoItem)
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
            ReturnItemCollectionMetrics: options.returnCollectionMetrics
        };
    }


    /**
     * Create update command.
     * @param itemKey - primary key of the item to create or update.
     * @param options - command options
     */
    update<V>(itemKey: Key, options: UpdateOptions<T, V> = {}): ddb.UpdateItemCommandInput {
        const {table: {name}, context} = this
        const dynamoKey = marshall(itemKey, MarshalOptions)
        const value = {...options.values, ...itemKey} as V & Key
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
                ReturnItemCollectionMetrics: options.returnCollectionMetrics,
            };
        } finally {
            context.end()
        }
    }

    /**
     * Create delete command.
     * @param itemKey - primary key of the item to delete.
     * @param options - command options
     */
    delete<V>(itemKey: Key, options: DeleteOptions<T, V> = {}): ddb.DeleteItemCommandInput {
        const {context, table: {name}} = this
        const dynamoKey = marshall(itemKey, MarshalOptions)
        const values = {...options.values, ...itemKey} as V & Key
        const ctx = context.begin(values, dynamoKey)

        try {
            const {condition} = options
            const cond = joinAnd(condition?.(ctx))
            return {
                TableName: name,
                Key: dynamoKey,
                ConditionExpression: cond,
                ReturnValues: options.return,
                ReturnValuesOnConditionCheckFailure: options.returnOnConditionFailure,
                ReturnItemCollectionMetrics: options.returnItemsCollectionMetrics,
                ReturnConsumedCapacity: options.returnConsumedCapacity,
                ExpressionAttributeNames: context.attributes,
                ExpressionAttributeValues: context.values
            };
        } finally {
            context.end()
        }
    }

    /**
     * Create {@link ddb.QueryCommandInput}.
     * @param command - command parameters
     * @param startKey - the primary key of the first item that this operation will evaluate. Use the value that was returned for LastEvaluatedKey in the previous operation.
     */
    query<V>(command: QueryOptions<T, V>, startKey?: Key): ddb.QueryCommandInput {
        const {table: {name, index}, context} = this
        const ctx = context.begin(command.values)

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
                ExclusiveStartKey: startKey !== undefined ? marshall(startKey, MarshalOptions) : undefined,
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
     * @param startKey - the primary key of the first item that this operation will evaluate. Use the value that was returned for LastEvaluatedKey in the previous operation.
     */
    scan<V>(command: ScanOptions<T, V>, startKey?: Key): ddb.ScanCommandInput {
        const {table: {name, index}, context} = this
        const ctx = context.begin(command.values)

        try {
            let {filter, projection} = command
            const projectionExpression = joinComma(projection?.(ctx))
            const filterExpression = joinAnd(filter?.(ctx))
            const exclusiveStartKey = startKey !== undefined ? marshall(startKey, MarshalOptions) : undefined;
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

    with(tx: TransactWriteBuilder): TableTransactWrite<T, Key>
    with(tx: TransactGetBuilder): TableTransactGet<T, Key>
    with(tx: BatchWriteBuilder): TableBatchWrite<Key, schema.AttributesType<T>>
    with(tx: BatchGetBuilder): TableBatchGet<T, Key>
    with(tx: TransactGetBuilder | TransactWriteBuilder | BatchWriteBuilder | BatchGetBuilder) {
        const {context, table: {name}} = this
        if (tx instanceof TransactGetBuilder) return new TableTransactGet(tx, context, name)

        if (tx instanceof TransactWriteBuilder) return new TableTransactWrite(tx, context, name)

        if (tx instanceof BatchWriteBuilder) return new TableBatchWrite(tx, name)

        return new TableBatchGet(tx, context, name)
    }
}

/**
 * DynamoDb {@link ddb.KeysAndAttributes} for a given {@link TableSchema}
 */
interface BatchGetItemOptions<T extends schema.TableSchema> {
    /**
     * Projection expression generator. See more [here]{@link ProjectionGenerator}.
     */
    projection?: ProjectionGenerator<T>
    /**
     * See {@link ddb.BatchGetItemInput.ConsistentRead}
     */
    consistentRead?: boolean,
}

class TableBatchGet<T extends schema.TableSchema, Key> {

    constructor(private readonly builder: BatchGetBuilder,
                private readonly context: Context<T>,
                private readonly name: string) {
    }

    /**
     * Add new item to the batch.
     *
     * @param keys - The primary key attribute values that define the items and the attributes associated with the items.
     * @param options - batch options
     */
    get(keys: Key[], options: BatchGetItemOptions<T> = {}) {
        const {context, name, builder} = this
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

interface BatchGetOptions {
    /**
     * Determines the level of detail about either provisioned or on-demand throughput consumption that is returned in the response For more information see {@link ReturnConsumedCapacity}.
     */
    returnConsumedCapacity: ReturnConsumedCapacity
}

/**
 * Builds batch get operation.
 */
class BatchGetBuilder {

    private _items: Record<string, ddb.KeysAndAttributes> = {}
    private _returnConsumedCapacity: ddb.ReturnConsumedCapacity | undefined

    constructor(private readonly ctx: DynamoDBContext) {
    }

    /**
     * See {@link ddb.BatchGetItemCommandInput.ReturnConsumedCapacity}
     * @param capacity
     */
    returnConsumedCapacity(capacity: ddb.ReturnConsumedCapacity): BatchGetBuilder {
        this._returnConsumedCapacity = capacity
        return this
    }

    /**
     * Set operation options with a single call.
     * @param options - operation options
     */
    options(options: BatchGetOptions): BatchGetBuilder {
        this._returnConsumedCapacity = options.returnConsumedCapacity
        return this
    }

    /**
     * Build {@link ddb.BatchGetItemCommandInput}
     */
    build(): ddb.BatchGetItemCommandInput {
        return {
            RequestItems: this._items,
            ReturnConsumedCapacity: this._returnConsumedCapacity
        }
    }

    /**
     * Build {@link ddb.BatchGetItemCommand}
     */
    command(): ddb.BatchGetItemCommand {
        return new ddb.BatchGetItemCommand(this.build())
    }

    set(name: string, kv: ddb.KeysAndAttributes) {
        this._items[name] = kv
    }

    async exec(): Promise<BatchGetResponse> {
        const {db, unmarshallOptions} = this.ctx
        const input = this.build()
        const response = await db.batchGetItem(input).catch(e => {
            throw errorWithContext(e, "batchGet", {input})
        })
        return {
            ...response,
            Responses: _.mapValues(response.Responses, function (v) {
                return v.map(function (vv) {
                    return unmarshall(vv, unmarshallOptions)
                })
            }),
            UnprocessedKeys: _.mapValues(response.UnprocessedKeys, function (v) {
                const keys = v.Keys?.map(function (vv) {
                    return unmarshall(vv, unmarshallOptions)
                });
                return {
                    ...v,
                    Keys: keys ?? []
                }
            })
        }
    }
}

/**
 * DynamoDb {@link ddb.WriteRequest} for a given {@link TableSchema}
 */
type BatchWriteItem<Key, Item> = BatchPutItem<Key, Item> | BatchDeleteItem<Key>

/**
 * Request to put an item into the table (see {@link ddb.PutRequest}).
 */
interface BatchPutItem<Key, Item> {
    /**
     * Indicate delete request.
     */
    action: "put",
    /**
     * Non-key attributes.
     */
    item: Item,
    /**
     * Primary key of the item to put.
     */
    key: Key
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


class TableBatchWrite<Key, Item> {

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
                    this.put(x.key, x.item)
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
    put(itemKey: Key, item: Item) {
        const {name, builder} = this
        const data = {...itemKey, ...item};
        builder.append(name, {
            PutRequest: {
                Item: marshall(data, MarshalOptions)
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

interface BatchWriteOptions {
    /**
     * See {@link ddb.BatchWriteItemInput.ReturnConsumedCapacity}
     */
    returnConsumedCapacity?: ddb.ReturnConsumedCapacity
    /**
     * Determines whether item collection metrics are returned. If set to `SIZE`, the response includes statistics about item collections, if any, that were modified during the operation are returned in the response. If set to `NONE` (the default), no statistics are returned.
     */
    returnItemCollectionMetrics?: ddb.ReturnItemCollectionMetrics
}

/**
 * Builds batch write operation.
 */
class BatchWriteBuilder {
    constructor(private readonly ctx: DynamoDBContext) {
    }

    private _requests: Record<string, ddb.WriteRequest[]> = {};
    private _returnConsumedCapacity: ddb.ReturnConsumedCapacity | undefined;
    private _returnItemCollectionMetrics: ddb.ReturnItemCollectionMetrics | undefined;

    append(name: string, request: ddb.WriteRequest) {
        const {_requests} = this
        const batch = _requests[name] ?? (_requests[name] = [])
        batch.push(request)
    }

    /**
     * See {@link ddb.BatchWriteItemInput.ReturnConsumedCapacity}
     * @param capacity - consumed capacity setting
     */
    returnConsumedCapacity(capacity: ddb.ReturnConsumedCapacity): BatchWriteBuilder {
        this._returnConsumedCapacity = capacity
        return this
    }

    /**
     * Determines whether item collection metrics are returned. If set to `SIZE`, the response includes statistics about item collections, if any, that were modified during the operation are returned in the response. If set to `NONE` (the default), no statistics are returned.
     * @param metrics - item collection metric setting
     */
    returnItemCollectionMetrics(metrics: ddb.ReturnItemCollectionMetrics): BatchWriteBuilder {
        this._returnItemCollectionMetrics = metrics
        return this
    }

    /**
     * Set operation options with a single call.
     * @param options - operation options
     */
    options(options: BatchWriteOptions): BatchWriteBuilder {
        this._returnConsumedCapacity = options.returnConsumedCapacity
        this._returnItemCollectionMetrics = options.returnItemCollectionMetrics
        return this
    }

    /**
     * Build {@link ddb.BatchWriteItemCommandInput}
     */
    build(): ddb.BatchWriteItemCommandInput {
        return {
            RequestItems: this._requests,
            ReturnConsumedCapacity: this._returnConsumedCapacity,
            ReturnItemCollectionMetrics: this._returnItemCollectionMetrics
        }
    }

    /**
     * Build {@link ddb.BatchWriteItemCommand}
     */
    command(): ddb.BatchWriteItemCommand {
        return new ddb.BatchWriteItemCommand(this.build())
    }

    async exec(): Promise<BatchWriteResponse> {
        const {db} = this.ctx
        const input = this.build();
        return db.batchWriteItem(input).catch(e => {
            throw errorWithContext(e, "batchWrite", {input})
        })
    }
}

/**
 * DynamoDb {@link ddb.KeysAndAttributes} for a given {@link TableSchema}
 */
interface TransactGetItem<T extends schema.TableSchema> {
    /**
     * Projection expression generator. See more [here]{@link ProjectionGenerator}.
     */
    projection?: ProjectionGenerator<T>
}

interface TransactGetOptions {
    /**
     * See {@link ddb.TransactGetItemsInput.ReturnConsumedCapacity}
     */
    returnConsumedCapacity?: ddb.ReturnConsumedCapacity
}

class TableTransactGet<T extends schema.TableSchema, Key extends schema.KeyType<T>> {
    constructor(private readonly builder: TransactGetBuilder,
                private readonly context: Context<T>,
                private readonly name: string) {
    }

    /**
     * Add get item transaction step.
     */
    get(itemKey: Key, item: TransactGetItem<T> = {}) {
        const {name, context, builder} = this
        const dynamoKey = marshall(itemKey, MarshalOptions)
        const ctx = context.begin()
        try {
            const {projection} = item
            const projectionExpression = joinComma(projection?.(ctx))
            builder.addItem({
                Get: {
                    TableName: name,
                    Key: dynamoKey,
                    ProjectionExpression: projectionExpression,
                    ExpressionAttributeNames: context.attributes
                }
            })
        } finally {
            context.end()
        }

        return this
    }
}

/**
 * Builds batch get operation.
 */
class TransactGetBuilder {
    constructor(private readonly ctx: DynamoDBContext) {

    }

    private items: ddb.TransactGetItem[] = []
    private _returnConsumedCapacity: ddb.ReturnConsumedCapacity | undefined

    /**
     * See {@link ddb.TransactGetItemsInput.ReturnConsumedCapacity}
     * @param capacity
     */
    returnConsumedCapacity(capacity: ddb.ReturnConsumedCapacity): TransactGetBuilder {
        this._returnConsumedCapacity = capacity
        return this
    }

    /**
     * Set operation options with a single call.
     * @param options - operation options
     */
    options(options: TransactGetOptions): TransactGetBuilder {
        this._returnConsumedCapacity = options.returnConsumedCapacity
        return this
    }

    /**
     * Build {@link ddb.TransactGetItemsInput}
     */
    build(): ddb.TransactGetItemsInput {
        return {
            TransactItems: this.items,
            ReturnConsumedCapacity: this._returnConsumedCapacity
        };
    }

    /**
     * Build {@link ddb.TransactGetItemsCommand}
     */
    command(): ddb.TransactGetItemsCommand {
        return new ddb.TransactGetItemsCommand(this.build())
    }

    addItem(item: ddb.TransactGetItem) {
        this.items.push(item)
    }

    async exec(): Promise<TransactGetResponse> {
        const {db, unmarshallOptions} = this.ctx
        const input = this.build();
        const response = await db.transactGetItems(input).catch(e => {
            throw errorWithContext(e, "transactGet", {input})
        })
        if (response.Responses === undefined)
            throw internalError("Unexpected error: Responses is undefined").withContext("transactGet", {input})
        return {
            ...response,
            Responses: response.Responses.map(x => x.Item !== undefined ? unmarshall(x.Item, unmarshallOptions) : undefined)
        }
    }
}


/**
 * Defines {@link ddb.TransactWriteItem} for a {@link ddb.TransactWriteItemsCommand}
 */
export type TransactWriteItem<T extends schema.TableSchema, V = any> =
    TransactPutItem<T, V>
    | TransactUpdateItem<T, V>
    | TransactDeleteItem<T, V>
    | TransactCheckItem<T, V>

/**
 * Request to put an item into the table (see {@link ddb.Put}).
 */
interface TransactPutItem<T extends schema.TableSchema, V> {
    /**
     * Indicate put request.
     */
    action: "put",
    /**
     * Non-key attributes.
     */
    item?: schema.AttributesType<T>,
    /**
     * Context values to be used in expressions generated by {@link condition}.
     */
    values?: V
    /**
     * Condition expression generator. See more [here]{@link ConditionGenerator}.
     */
    condition?: ConditionGenerator<T, schema.KeyType<T> & schema.AttributesType<T> & V>
    /**
     * Use returnOnConditionFailure to get the item attributes if the `PUT` condition fails. The valid values are: `NONE` and `ALL_OLD`.
     */
    returnOnConditionFailure?: ddb.ReturnValuesOnConditionCheckFailure
}

/**
 * Request to put an item into the table (see {@link ddb.Update}).
 */
interface TransactUpdateItem<T extends schema.TableSchema, V> {
    /**
     * Indicate put request.
     */
    action: "update",
    /**
     * Context values to be used in expressions generated by {@link expression} or {@link condition}.
     */
    values?: V,
    /**
     * Function generating {@link ddb.Update.UpdateExpression}
     */
    expression: UpdateGenerator<T, schema.KeyType<T> & V>
    /**
     * Condition expression generator. See more [here]{@link ConditionGenerator}.
     */
    condition?: ConditionGenerator<T, schema.KeyType<T> & V>
    /**
     * Use returnOnConditionFailure to get the item attributes if the `UPDATE` condition fails. The valid values are: `NONE` and `ALL_OLD`.
     */
    returnOnConditionFailure?: ddb.ReturnValuesOnConditionCheckFailure
}

/**
 * Request to delete an item from the table (see {@link ddb.Delete}).
 */
interface TransactDeleteItem<T extends schema.TableSchema, V> {
    /**
     * Indicate delete request.
     */
    action: "delete",
    /**
     * Context values to be used in expressions generated by {@link condition}.
     */
    values?: V,
    /**
     * Condition expression generator. See more [here]{@link ConditionGenerator}.
     */
    condition?: ConditionGenerator<T, schema.KeyType<T> & V>
    /**
     * Use returnOnConditionFailure to get the item attributes if the `DELETE` condition fails. The valid values are: `NONE` and `ALL_OLD`.
     */
    returnOnConditionFailure?: ddb.ReturnValuesOnConditionCheckFailure
}

/**
 * Request to put an item into the table (see {@link ddb.ConditionCheck}).
 */
interface TransactCheckItem<T extends schema.TableSchema, V> {
    /**
     * Indicate put request.
     */
    action: "check",
    /**
     * Context values to be used in expressions generated by {@link condition}.
     */
    values?: V,
    /**
     * Condition expression generator. See more [here]{@link ConditionGenerator}.
     */
    condition: ConditionGenerator<T, schema.KeyType<T> & V>
    /**
     * Use returnOnConditionFailure to get the item attributes if the `CHECK` condition fails. The valid values are: `NONE` and `ALL_OLD`.
     */
    returnOnConditionFailure?: ddb.ReturnValuesOnConditionCheckFailure
}

interface TransactWriteOptions {
    /**
     * See {@link ddb.TransactWriteItemsInput.ReturnConsumedCapacity}
     */
    returnConsumedCapacity?: ddb.ReturnConsumedCapacity
    /**
     * Determines whether item collection metrics are returned. If set to `SIZE`, the response includes statistics about item collections, if any, that were modified during the operation are returned in the response. If set to `NONE` (the default), no statistics are returned.
     */
    returnItemCollectionMetrics?: ddb.ReturnItemCollectionMetrics,
    /**
     * See {@link ddb.TransactWriteItemsInput.ClientRequestToken}
     */
    clientRequestToken?: string
}

/**
 * Builds batch write operation.
 */
class TransactWriteBuilder {
    private items: ddb.TransactWriteItem[] = [];
    private _returnConsumedCapacity: ddb.ReturnConsumedCapacity | undefined = undefined;
    private _returnItemCollectionMetrics: ddb.ReturnItemCollectionMetrics | undefined = undefined;
    private _clientRequestToken: string | undefined = undefined

    constructor(private readonly ctx: DynamoDBContext) {
    }

    /**
     * See {@link ddb.TransactWriteItemsInput.ReturnConsumedCapacity}
     * @param capacity - consumed capacity setting
     */
    returnConsumedCapacity(capacity: ddb.ReturnConsumedCapacity) {
        this._returnConsumedCapacity = capacity
        return this
    }

    /**
     * Determines whether item collection metrics are returned. If set to `SIZE`, the response includes statistics about item collections, if any, that were modified during the operation are returned in the response. If set to `NONE` (the default), no statistics are returned.
     * @param metrics - item collection metric setting
     */
    returnItemCollectionMetrics(metrics: ddb.ReturnItemCollectionMetrics) {
        this._returnItemCollectionMetrics = metrics
        return this
    }

    /**
     * See {@link ddb.TransactWriteItemsInput.ClientRequestToken}
     * @param token - idempotency token
     */
    clientRequestToken(token: string) {
        this._clientRequestToken = token
        return this
    }

    /**
     * Set all options with a single call.
     * @param options - transaction options
     */
    options(options: TransactWriteOptions) {
        this._returnConsumedCapacity = options.returnConsumedCapacity
        this._returnItemCollectionMetrics = options.returnItemCollectionMetrics
        this._clientRequestToken = options.clientRequestToken
        return this
    }

    /**
     * Build {@link ddb.TransactWriteItemsCommandInput}
     */
    build(): ddb.TransactWriteItemsCommandInput {
        return {
            TransactItems: this.items,
            ClientRequestToken: this._clientRequestToken,
            ReturnConsumedCapacity: this._returnConsumedCapacity,
            ReturnItemCollectionMetrics: this._returnItemCollectionMetrics
        }
    }

    /**
     * Build {@link ddb.TransactWriteItemsCommand}
     */
    command(): ddb.TransactWriteItemsCommand {
        return new ddb.TransactWriteItemsCommand(this.build())
    }

    addItem(item: ddb.TransactWriteItem) {
        this.items.push(item)
    }

    exec(): Promise<TransactWriteResponse> {
        const {db} = this.ctx
        const input = this.build();
        return db.transactWriteItems(input).catch(e => {
            throw errorWithContext(e, "transactWrite", {input})
        })
    }
}

class TableTransactWrite<T extends schema.TableSchema, Key extends schema.KeyType<T>> {
    constructor(private readonly builder: TransactWriteBuilder,
                private readonly context: Context<T>,
                private readonly name: string) {
    }


    put<V>(itemKey: Key, txItem: Omit<TransactPutItem<T, V>, 'action'>) {
        const {builder, context, name} = this
        const dynamoItem = marshall({...txItem.item, ...itemKey}, MarshalOptions)
        const values = {...txItem.values, ...txItem.item, ...itemKey} as Key & schema.AttributesType<T> & V;
        const ctx = context.begin(values, dynamoItem)
        try {
            const {condition} = txItem
            const exp = joinAnd(condition?.(ctx))
            builder.addItem({
                Put: {
                    TableName: name,
                    Item: dynamoItem,
                    ConditionExpression: exp,
                    ReturnValuesOnConditionCheckFailure: txItem.returnOnConditionFailure,
                    ExpressionAttributeNames: context.attributes,
                    ExpressionAttributeValues: context.values,
                }
            })
        } finally {
            context.end()
        }
        return this
    }

    update<V>(itemKey: Key, txItem: Omit<TransactUpdateItem<T, V>, 'action'>) {
        const {builder, context, name} = this
        const dynamoKey = marshall(itemKey, MarshalOptions)
        const values = {...txItem.values, ...itemKey} as Key & V;
        const ctx = context.begin(values, dynamoKey)
        try {
            const {expression, condition} = txItem
            const ue = updateExpression(expression?.(ctx))
            const cond = joinAnd(condition?.(ctx))
            builder.addItem({
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
        } finally {
            context.end()
        }
        return this
    }

    delete<V>(itemKey: Key, txItem: Omit<TransactDeleteItem<T, V>, 'action'>) {
        const {builder, context, name} = this
        const values = {...txItem.values, ...itemKey} as V & Key;
        const dynamoKey = marshall(itemKey, MarshalOptions)
        const ctx = context.begin(values, dynamoKey)
        try {
            const {condition} = txItem
            const cond = joinAnd(condition?.(ctx))
            builder.addItem({
                Delete: {
                    TableName: name,
                    Key: dynamoKey,
                    ConditionExpression: cond,
                    ReturnValuesOnConditionCheckFailure: txItem.returnOnConditionFailure,
                    ExpressionAttributeNames: context.attributes,
                    ExpressionAttributeValues: context.values,
                }
            })
        } finally {
            context.end()
        }
        return this
    }

    check<V>(itemKey: Key, txItem: Omit<TransactCheckItem<T, V>, 'action'>) {
        const {builder, context, name} = this
        const values = {...txItem.values, ...itemKey} as V & Key;
        const dynamoKey = marshall(itemKey, MarshalOptions)
        const ctx = context.begin(values, dynamoKey)
        try {
            const {condition} = txItem
            const cond = joinAnd(condition?.(ctx))
            builder.addItem({
                ConditionCheck: {
                    TableName: name,
                    Key: dynamoKey,
                    ConditionExpression: cond,
                    ReturnValuesOnConditionCheckFailure: txItem.returnOnConditionFailure,
                    ExpressionAttributeNames: context.attributes,
                    ExpressionAttributeValues: context.values,
                }
            })
        } finally {
            context.end()
        }
        return this
    }

    exec<V>(itemKey: Key, item: TransactWriteItem<T, V>) {
        switch (item.action) {
            case "check":
                return this.check(itemKey, item)
            case "put":
                return this.put(itemKey, item)
            case "update":
                return this.update(itemKey, item)
            case "delete":
                return this.delete(itemKey, item)
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


interface DynamoDBOptions {
    db?: ddb.DynamoDB,
    unmarshallOptions?: unmarshallOptions
}

export interface DynamoDBContext {
    db: ddb.DynamoDB,
    unmarshallOptions?: unmarshallOptions
}


interface GetResponse<T extends schema.TableSchema> extends Omit<ddb.GetItemCommandOutput, 'Item'> {
    Item?: schema.ItemType<T>
}

interface UpdateResponse<T extends schema.TableSchema> extends Omit<ddb.UpdateItemCommandOutput, 'Attributes'> {
    Attributes?: schema.ItemType<T>
}

interface PutResponse<T extends schema.TableSchema> extends Omit<ddb.PutItemCommandOutput, 'Attributes'> {
    Attributes?: schema.ItemType<T>
}

interface DeleteResponse<T extends schema.TableSchema> extends Omit<ddb.DeleteItemCommandOutput, 'Attributes'> {
    Attributes?: schema.ItemType<T>
}

interface QueryResponse<T extends schema.TableSchema> extends Omit<ddb.QueryCommandOutput, 'Items'> {
    Items: schema.ItemType<T>[]
}

interface ScanResponse<T extends schema.TableSchema> extends Omit<ddb.ScanCommandOutput, 'Items'> {
    Items: schema.ItemType<T>[]
}

interface TransactGetResponse<T = unknown> extends Omit<ddb.TransactGetItemsCommandOutput, 'Responses'> {
    'Responses': (T | undefined)[]
}

type TransactWriteResponse = ddb.TransactWriteItemsCommandOutput

interface KeysAndAttributes<T = Record<string, any>> extends Omit<ddb.KeysAndAttributes, 'Keys'> {
    Keys: T[]
}

interface BatchGetResponse extends Omit<ddb.BatchGetItemCommandOutput, 'Responses' | 'UnprocessedKeys'> {
    Responses: Record<string, unknown[]>
    UnprocessedKeys?: Record<string, KeysAndAttributes>
}

type BatchWriteResponse = ddb.BatchWriteItemCommandOutput

interface TableBatchGetResponse<T extends schema.TableSchema> extends Omit<ddb.BatchGetItemCommandOutput, 'Responses' | 'UnprocessedKeys'> {
    Responses: schema.ItemType<T>[]
    UnprocessedKeys?: KeysAndAttributes<schema.KeyType<T>>
}

interface TableBatchWriteResponse<T extends schema.TableSchema, Key> extends Omit<BatchWriteResponse, 'UnprocessedKeys'> {
    UnprocessedKeys?: BatchWriteItem<Key, schema.AttributesType<T>>[]
}


export class DynamoDB implements DynamoDBContext {
    public readonly db: ddb.DynamoDB;
    public readonly unmarshallOptions?: unmarshallOptions

    constructor(options?: DynamoDBOptions) {
        options = options ?? {}
        this.db = options.db ?? new ddb.DynamoDB()
        this.unmarshallOptions = options.unmarshallOptions
    }

    table<const T extends schema.TableSchema>(table: T) {
        return new DDBTable(this, table)
    }

    batchGet() {
        return new BatchGetBuilder(this)
    }

    batchWrite() {
        return new BatchWriteBuilder(this)
    }

    transactGet() {
        return new TransactGetBuilder(this)
    }

    transactWrite() {
        return new TransactWriteBuilder(this)
    }
}

export class DDBTable<T extends schema.TableSchema, Key extends schema.KeyType<T> = schema.KeyType<T>> {
    private builder: CommandBuilder<T, Key>

    /**
     * DynamoDB table name
     */
    get name() { return this.schema.name }
    /**
     * Key attributes (partition and sort key).
     */
    get key() { return this.schema.key }
    /**
     * All other than key attributes of the table.
     */
    get attributes() { return this.schema.attributes }
    /**
     * DynamoDB index name
     */
    get index() { return this.schema.index }

    constructor(public readonly ctx: DynamoDBContext, public readonly schema: T) {
        this.builder = new CommandBuilder(schema)
    }

    /**
     * Cast table to one with a slightly different key type. Useful to constraint type of keys.
     *
     * @example single table design
     * const root = table("users", {uid: Type.String, sk:Type.String}, {})
     * const users = root.withKey<{uid:`U#${string}`, sk:`U`}>()
     * const attributes = root.withKey<{uid:`U#${string}`, sk:`A#${string}`}>()
     * const aliases = root.withKey<{uid:`AL#${string}`, sk:`U#${string}`}>()
     */
    forKey<NewKeyType extends schema.KeyType<T>>() {
        return this as unknown as DDBTable<T, NewKeyType>
    }

    /**
     * Execute GetItem DynamoDB command.
     * @param itemKey - primary key of the item to retrieve.
     * @param options - command options
     */
    async get(itemKey: Key, options: GetOptions<T> = {}): Promise<GetResponse<T>> {
        const {ctx: {db, unmarshallOptions}, builder} = this
        const input = builder.get(itemKey, options)
        const response = await db.getItem(input).catch(e => {
            throw errorWithContext(e, "get", {input})
        })
        const item = response.Item !== undefined ? unmarshall(response.Item, unmarshallOptions) as schema.ItemType<T> : undefined;
        return {
            ...response,
            Item: item
        }
    }

    /**
     * Execute PutItem DynamoDB command.
     * @param itemKey - primary key of the item to put.
     * @param options - command options
     */
    async put<V>(itemKey: Key, options: PutOptions<T, V>): Promise<PutResponse<T>> {
        const {ctx: {db, unmarshallOptions}, builder} = this
        const input = builder.put(itemKey, options)
        const response = await db.putItem(input).catch(e => {
            throw errorWithContext(e, "put", {input})
        })
        const attributes = response.Attributes !== undefined ? unmarshall(response.Attributes, unmarshallOptions) : undefined
        return {
            ...response,
            Attributes: attributes as schema.ItemType<T>
        }
    }

    /**
     * Execute DynamoDB Update command.
     * @param itemKey - primary key of the item to update.
     * @param options - command options
     */
    async update<V>(itemKey: Key, options: UpdateOptions<T, V>): Promise<UpdateResponse<T>> {
        const {ctx: {db, unmarshallOptions}, builder} = this
        const input = builder.update(itemKey, options)
        const response = await db.updateItem(input).catch(e => {
            throw errorWithContext(e, "update", {input})
        })
        const attributes = response.Attributes !== undefined ? unmarshall(response.Attributes, unmarshallOptions) : undefined
        return {
            ...response,
            Attributes: attributes as schema.ItemType<T>
        }
    }

    /**
     * Execute DynamoDB DeleteItem command.
     * @param itemKey - primary key of the item to delete.
     * @param options - command options
     */
    async delete<V>(itemKey: Key, options: DeleteOptions<T, V> = {}): Promise<DeleteResponse<T>> {
        const {ctx: {db, unmarshallOptions}, builder} = this
        const input = builder.delete(itemKey, options)
        const response = await db.deleteItem(input).catch(e => {
            throw errorWithContext(e, "delete", {input})
        })
        const attributes = response.Attributes !== undefined ? unmarshall(response.Attributes, unmarshallOptions) : undefined;
        return {
            ...response,
            Attributes: attributes as schema.ItemType<T>
        }
    }

    /**
     * Run DynamoDB Query command.
     * @param options - command options
     * @param startKey - query start key
     */
    async query<V>(options: QueryOptions<T, V>, startKey?: Key): Promise<QueryResponse<T>> {
        const {ctx: {db, unmarshallOptions}, builder} = this
        const input = builder.query(options, startKey);
        const response = await db.query(input).catch(e => {
            throw errorWithContext(e, "query", {input})
        })
        if (response.Items === undefined)
            throw internalError("Unexpected error: Items is undefined").withContext("update", {input})
        return {
            ...response,
            Items: response.Items.map(x => unmarshall(x, unmarshallOptions) as schema.ItemType<T>)
        }
    }

    /**
     * Run DynamoDB Scan command.
     * @param options - command options
     * @param startKey - scan operation start key
     */
    async scan<V>(options: ScanOptions<T, V>, startKey?: Key): Promise<ScanResponse<T>> {
        const {ctx: {db, unmarshallOptions}, builder} = this
        const input = builder.scan(options, startKey)
        const response = await db.scan(input).catch(e => {
            throw errorWithContext(e, "scan", {input})
        })
        if (response.Items === undefined)
            throw internalError("Unexpected error: Items is undefined").withContext("scan", {input})
        return {
            ...response,
            Items: response.Items.map(x => unmarshall(x, unmarshallOptions) as schema.ItemType<T>)
        }
    }

    /**
     * Run DynamoDB BatchGetItem command. This is similar to {@link DynamoDB.batchGet} but limited to just one table and also better typed.
     * @param keys - item keys
     * @param options - command options
     */
    async batchGet(keys: Key[], options?: BatchGetItemOptions<T> & BatchGetOptions): Promise<TableBatchGetResponse<T>> {
        const {schema} = this
        const batch = new BatchGetBuilder(this.ctx);
        this.builder.with(batch).get(keys, options)
        if (options !== undefined) {
            batch.options(options)
        }
        const response = await batch.exec()
        const responses = response.Responses?.[schema.name] as schema.ItemType<T>[]
        if (responses === undefined)
            throw unexpectedError()
        const unprocessedKeys = response.UnprocessedKeys?.[schema.name] as KeysAndAttributes<schema.KeyType<T>>
        return {
            ...response,
            Responses: responses,
            UnprocessedKeys: unprocessedKeys
        }

        function unexpectedError() {
            return internalError("Unexpected error: Responses is undefined").withContext("batchGet", {keys, options})
        }
    }

    /**
     * Run DynamoDB BatchGetItem command. This is similar to {@link DynamoDB.batchWrite} but limited to just one table and also better typed.
     * @param items - batch items
     * @param options - command options
     */
    async batchWrite(items: BatchWriteItem<Key, schema.AttributesType<T>>[], options?: BatchWriteOptions): Promise<TableBatchWriteResponse<T, Key>> {
        const {schema, ctx: {unmarshallOptions}} = this
        const batch = new BatchWriteBuilder(this.ctx);
        this.builder.with(batch).add(items)
        if (options !== undefined) {
            batch.options(options)
        }
        const response = await batch.exec()
        const unprocessedKeys = response.UnprocessedItems?.[schema.name]
        return {
            ...response,
            UnprocessedKeys: _.map(unprocessedKeys, function ({DeleteRequest, PutRequest}) {
                if (PutRequest !== undefined) {
                    const {Item} = PutRequest
                    if (Item === undefined)
                        throw unexpectedError()
                    const item = unmarshall(Item, unmarshallOptions)
                    return {
                        action: "put",
                        item: item as schema.AttributesType<T>,
                        key: item as Key,
                    }
                } else if (DeleteRequest !== undefined) {
                    const {Key} = DeleteRequest
                    if (Key === undefined)
                        throw unexpectedError()
                    return {
                        action: "delete",
                        key: unmarshall(Key, unmarshallOptions) as Key
                    }
                } else {
                    throw unexpectedError()
                }
            })
        }

        function unexpectedError() {
            return internalError("Unexpected undefined value while processing batch write response")
                .withContext("batchWrite", {items, options, response})
        }
    }

    /**
     * Create transaction builder for the table.
     * @param tx - transaction builder
     */
    with(tx: TransactWriteBuilder): TableTransactWrite<T, Key>
    /**
     * Create transaction builder for the table.
     * @param tx - transaction builder
     */
    with(tx: TransactGetBuilder): TableTransactGet<T, Key>
    /**
     * Create batch builder for the table.
     * @param batch - batch operation builder
     */
    with(batch: BatchWriteBuilder): TableBatchWrite<Key, schema.AttributesType<T>>
    /**
     * Create batch builder for the table.
     * @param batch - batch operation builder
     */
    with(batch: BatchGetBuilder): TableBatchGet<T, Key>
    with(tx: TransactGetBuilder | TransactWriteBuilder | BatchWriteBuilder | BatchGetBuilder) {
        if (tx instanceof TransactGetBuilder) return this.builder.with(tx)
        if (tx instanceof TransactWriteBuilder) return this.builder.with(tx)
        if (tx instanceof BatchWriteBuilder) return this.builder.with(tx)
        return this.builder.with(tx)
    }

}