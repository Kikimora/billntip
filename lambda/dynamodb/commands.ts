import * as ddb from "@aws-sdk/client-dynamodb";
import {IfUnknown} from "type-fest";
import _ from "lodash";
import {unmarshall, unmarshallOptions} from "@aws-sdk/util-dynamodb";
import {internalError} from "@app/lambda";
import {errorWithContext} from "@app/diagnostics";
import * as input from "./inputs";
import * as DDB from "./schema";

export * from "./schema"

/**
 * Create DynamoDB object providing function to query and update DynamoDB tables.
 * @param options - dynamodb options
 */
export function dynamodb(options?: DynamoDBOptions) {
    return new DynamoDB(options)
}

interface BatchGetOptions {
    /**
     * Determines the level of detail about either provisioned or on-demand throughput consumption that is returned in the response For more information see {@link ReturnConsumedCapacity}.
     */
    returnConsumedCapacity?: ddb.ReturnConsumedCapacity
}

/**
 * Builds batch get operation.
 */
class BatchGetBuilder implements input.BatchGetBuilder {

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
class BatchWriteBuilder implements input.BatchWriteBuilder {
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
        const {db, unmarshallOptions} = this.ctx
        const input = this.build();
        const output = await db.batchWriteItem(input).catch(e => {
            throw errorWithContext(e, "batchWrite", {input})
        })
        const response = output as BatchWriteResponse
        const unprocessedItems = output.UnprocessedItems;
        response.UnprocessedItems = {}
        if (unprocessedItems !== undefined) {
            for (const [table, items] of Object.entries(unprocessedItems)) {
                response.UnprocessedItems[table] = items
                    .map(function (item): input.BatchWriteItem<unknown, unknown> | undefined {
                        if (item.PutRequest !== undefined) {
                            if (item.PutRequest.Item === undefined)
                                throw internalError("Unexpected error").withContext("batchWriteItem", {
                                    input, output
                                })
                            return {
                                action: "put",
                                item: unmarshall(item.PutRequest.Item, unmarshallOptions)
                            }
                        } else if (item.DeleteRequest !== undefined) {
                            if (item.DeleteRequest.Key === undefined) {
                                throw internalError("Unexpected error").withContext("batchWriteItem", {
                                    input, output
                                })
                            }
                            return {
                                action: "delete",
                                key: unmarshall(item.DeleteRequest.Key, unmarshallOptions)
                            }
                        } else {
                            return undefined
                        }
                    })
                    .filter(function (x): x is input.BatchWriteItem<unknown, unknown> {
                        return x !== undefined
                    })
            }
        }
        return response
    }
}

interface TransactGetOptions {
    /**
     * See {@link ddb.TransactGetItemsInput.ReturnConsumedCapacity}
     */
    returnConsumedCapacity?: ddb.ReturnConsumedCapacity
}

/**
 * Builds batch get operation.
 */
class TransactGetBuilder implements input.TransactGetBuilder {
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
        const idx = this.items.length
        this.items.push(item)
        return idx
    }

    async exec(): Promise<TransactGetResponse> {
        const {db, unmarshallOptions} = this.ctx
        const input = this.build();
        const response = await db.transactGetItems(input).catch(e => {
            transactionFailed(e, "transactGetItems", unmarshallOptions)
        })
        if (response.Responses === undefined)
            throw internalError("Unexpected error: Responses is undefined").withContext("transactGet", {input})
        return {
            ...response,
            Responses: response.Responses.map(x => x.Item !== undefined ? unmarshall(x.Item, unmarshallOptions) : undefined)
        }
    }
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
export class TransactWriteBuilder implements input.TransactWriteBuilder {
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
        const idx = this.items.length
        this.items.push(item)
        return idx
    }

    get isEmpty() {
        return this.items.length === 0
    }

    exec(): Promise<TransactWriteResponse> {
        const {db, unmarshallOptions} = this.ctx
        const input = this.build();
        return db.transactWriteItems(input).catch(e => {
            transactionFailed(e, "transactWriteItems", unmarshallOptions)
        })
    }
}

function transactionFailed(e: any, op: string, o?: unmarshallOptions): never {
    if (e instanceof ddb.TransactionCanceledException) {
        const x = e as TransactionCanceledException
        x.Outcomes = e.CancellationReasons?.map(function (e) {
            return {
                Item: e.Item !== undefined ? unmarshall(e.Item, o) : undefined,
                Code: e.Code ?? "Unexpected",
                Message: e.Message ?? "Unexpected error"
            }
        }) ?? []
    }
    throw errorWithContext(e, op, {input})
}

export interface DynamoDBOptions {
    db?: ddb.DynamoDB,
    unmarshallOptions?: unmarshallOptions
}

export interface DynamoDBContext {
    db: ddb.DynamoDB,
    unmarshallOptions?: unmarshallOptions
}

interface TransactGetResponse<T = unknown> extends Omit<ddb.TransactGetItemsCommandOutput, 'Responses'> {
    'Responses': T[]
}

export type TransactionCanceledException = input.TransactionCanceledException
export type CancellationReason = input.CancellationReason
export const isTransactionCancelled = input.isTransactionCancelled
export const isTransactionConflict = input.isTransactionConflict

type TransactWriteResponse = ddb.TransactWriteItemsCommandOutput

interface KeysAndAttributes<T = Record<string, any>> extends Omit<ddb.KeysAndAttributes, 'Keys'> {
    Keys: T[]
}

interface BatchGetResponse extends Omit<ddb.BatchGetItemCommandOutput, 'Responses' | 'UnprocessedKeys'> {
    Responses: Record<string, unknown[]>
    UnprocessedKeys?: Record<string, KeysAndAttributes>
}

interface BatchWriteResponse extends Omit<ddb.BatchWriteItemCommandOutput, 'UnprocessedItems'> {
    UnprocessedItems?: Record<string, input.BatchWriteItem<unknown, unknown>[]>;
}

export class DynamoDB implements DynamoDBContext {
    public readonly db: ddb.DynamoDB;
    public readonly unmarshallOptions?: unmarshallOptions

    constructor(options?: DynamoDBOptions) {
        options = options ?? {}
        this.db = options.db ?? new ddb.DynamoDB()
        this.unmarshallOptions = options.unmarshallOptions
    }

    table<const T extends DDB.Schema>(name: string, schema: T, index?: string) {
        return new DDBTable<DDB.SchemaKeyType<T>, DDB.SchemaItemType<T>>(this, name, schema, index)
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

export type Table<T extends DDB.Schema> = DDBTable<DDB.SchemaKeyType<T>, DDB.SchemaItemType<T>>

/**
 * Make unknown properties optional.
 */
type OptionalUnknown<T> = DDB.Id<{ [K in keyof T as IfUnknown<T[K], never, K>]: T[K] } & { [K in keyof T]?: T[K] }>

class DDBTable<Key, NonKey> {
    private builder: input.InputBuilder<Key, NonKey>

    /**
     * Key attributes (partition and sort key).
     */
    get key() {
        return this.schema.key
    }

    /**
     * All other than key attributes of the table.
     */
    get attributes() {
        return this.schema.item
    }

    constructor(public readonly ctx: DynamoDBContext,
                /**
                 * DynamoDB table name
                 */
                public readonly name: string,
                public readonly schema: DDB.Schema,
                /**
                 * DynamoDB index name
                 */
                public readonly index?: string) {
        this.builder = new input.InputBuilder(name, schema, index)
    }

    narrow<T extends DDB.Schema>(_: T) {
        type NewKey = OptionalUnknown<Pick<DDB.SchemaKeyType<T>, keyof Key & string>>;
        type NewNonKey = OptionalUnknown<Pick<DDB.SchemaItemType<T>, keyof NonKey & string>>
        return this as unknown as DDBTable<NewKey, NewNonKey>
    }

    /**
     * Execute GetItem DynamoDB command.
     * @param options - command options
     */
    async get<O extends input.GetOptions<Key, NonKey>>(options: O) {
        interface Result extends Item<Key, NonKey, O>, ConsumedCapacity<O>, ddb.__MetadataBearer {
        }

        const {ctx: {db, unmarshallOptions}, builder} = this
        const input = builder.get(options)
        const response = await db.getItem(input).catch(e => {
            throw errorWithContext(e, "get", {input})
        })
        const item = response.Item !== undefined ? unmarshall(response.Item, unmarshallOptions) as DDB.Id<Key & NonKey> : undefined;
        return {
            ...response,
            Item: item
        } as unknown as Result
    }

    /**
     * Execute PutItem DynamoDB command.
     * @param options - command options
     * @param values - command values
     */
    async put<O extends input.PutOptions<Key, NonKey, V>, V>(options: O, values?: V) {
        interface Success extends Attributes<Key, NonKey, O>, ItemCollectionMetrics<O>, ConsumedCapacity<O>, ddb.__MetadataBearer {
            ConditionCheckFailed: false
        }

        interface Failure extends CheckFailedAttributes<Key, NonKey, O> {
            ConditionCheckFailed: true
        }

        type Result = Success | Failure

        const {ctx: {db, unmarshallOptions}, builder} = this
        const input = builder.put(options, values)
        try {
            const response = await db.putItem(input).catch(e => {
                throw errorWithContext(e, "put", {input})
            })
            const attributes = response.Attributes !== undefined ? unmarshall(response.Attributes, unmarshallOptions) : undefined
            return {
                ...response,
                Attributes: attributes as DDB.Id<Key & NonKey>,
                ConditionCheckFailed: false
            } as unknown as Result
        } catch (e: any) {
            return this.handleDynamoException(e, "put", input) as unknown as Result;
        }
    }

    /**
     * Execute DynamoDB Update command.
     * @param options - command options
     * @param values - command values
     */
    async update<V, O extends input.UpdateOptions<Key, NonKey, V>>(options: O, values?: V) {
        interface Success extends Attributes<Key, NonKey, O>, ItemCollectionMetrics<O>, ConsumedCapacity<O>, ddb.__MetadataBearer {
            ConditionCheckFailed: false
        }

        interface Failure extends CheckFailedAttributes<Key, NonKey, O> {
            ConditionCheckFailed: true
        }

        type Result = Success | Failure

        try {
            const {ctx: {db, unmarshallOptions}, builder} = this
            const input = builder.update(options, values)
            const response = await db.updateItem(input)
            const attributes = response.Attributes !== undefined ? unmarshall(response.Attributes, unmarshallOptions) : undefined
            return {
                ...response,
                Attributes: attributes as DDB.Id<Key & NonKey>,
                ConditionCheckFailed: false
            } as unknown as Result
        } catch (e: any) {
            return this.handleDynamoException(e, "update", options) as unknown as Result
        }
    }

    /**
     * Execute DynamoDB DeleteItem command.
     * @param options - command options
     * @param values - command values
     */
    async delete<O extends input.DeleteOptions<Key, NonKey, V>, V>(options: O, values?: V) {
        interface Success extends Attributes<Key, NonKey, O>, ItemCollectionMetrics<O>, ConsumedCapacity<O>, ddb.__MetadataBearer {
            ConditionCheckFailed: false
        }

        interface Failure extends CheckFailedAttributes<Key, NonKey, O> {
            ConditionCheckFailed: true
        }

        //type Result = ConditionalResult<O, Success, Failure>
        type Result = O['condition'] extends Function ? Success | Failure
            : O['condition'] extends Function | undefined ? Success | Failure
                : Success

        const {ctx: {db, unmarshallOptions}, builder} = this
        const input = builder.delete(options, values)
        try {
            const response = await db.deleteItem(input)
            const attributes = response.Attributes !== undefined ? unmarshall(response.Attributes, unmarshallOptions) : undefined;
            return {
                ...response,
                Attributes: attributes as DDB.Id<Key & NonKey>,
                ConditionCheckFailed: false
            } as unknown as Result
        } catch (e: any) {
            return this.handleDynamoException(e, "delete", options) as Result
        }
    }

    /**
     * Run DynamoDB Query command.
     * @param command - command options
     * @param values - command values
     */
    async query<O extends input.QueryOptions<Key, NonKey, V>, V>(command: O, values?: V) {

        interface Result extends ConsumedCapacity<O>, ddb.__MetadataBearer {
            Items: (DDB.Id<Key & NonKey>)[]
            LastEvaluatedKey?: Key
            Count: number
            ScannedCount: number
        }

        const {ctx: {db, unmarshallOptions}, builder} = this
        const input = builder.query(command, values);
        const response = await db.query(input).catch(e => {
            throw errorWithContext(e, "query", {input})
        })
        if (response.Items === undefined)
            throw internalError("Unexpected error: Items is undefined").withContext("update", {input})
        return {
            ...response,
            Items: response.Items.map(x => unmarshall(x, unmarshallOptions) as DDB.Id<Key & NonKey>),
            LastEvaluatedKey: response.LastEvaluatedKey !== undefined ? unmarshall(response.LastEvaluatedKey) as Key : undefined
        } as any as Result
    }

    /**
     * Run DynamoDB Scan command.
     * @param command - command input
     * @param values - command values
     */
    async scan<O extends input.ScanOptions<Key, NonKey, V>, V>(command: O, values?: V) {

        interface Result extends ConsumedCapacity<O>, ddb.__MetadataBearer {
            Items: (DDB.Id<Key & NonKey>)[]
            LastEvaluatedKey?: Key
            Count: number
            ScannedCount: number
        }

        const {ctx: {db, unmarshallOptions}, builder} = this
        const input = builder.scan(command, values)
        const response = await db.scan(input).catch(e => {
            throw errorWithContext(e, "scan", {input})
        })
        if (response.Items === undefined)
            throw internalError("Unexpected error: Items is undefined").withContext("scan", {input})
        return {
            ...response,
            Items: response.Items.map(x => unmarshall(x, unmarshallOptions) as DDB.Id<Key & NonKey>),
            LastEvaluatedKey: response.LastEvaluatedKey !== undefined ? unmarshall(response.LastEvaluatedKey) as Key : undefined
        } as any as Result
    }

    /**
     * Run DynamoDB BatchGetItem command. This is similar to {@link DynamoDB.batchGet} but limited to just one table and also better typed.
     * @param options - command options
     */
    async batchGet<O extends input.BatchGetItemOptions<Key, NonKey> & BatchGetOptions>(options: O) {

        interface Result extends BatchConsumedCapacity<O>, BatchResponses<Key, NonKey, O>, ddb.__MetadataBearer {
        }

        const {name} = this
        const batch = new BatchGetBuilder(this.ctx);
        this.builder.batchGet(batch).get(options)
        if (options !== undefined) {
            batch.options(options)
        }
        const response = await batch.exec()
        const responses = response.Responses?.[name] as (DDB.Id<Key & NonKey>)[]
        if (responses === undefined)
            throw unexpectedError()
        const unprocessedKeys = response.UnprocessedKeys?.[name] as KeysAndAttributes<Key>
        return {
            ...response,
            Responses: responses,
            UnprocessedKeys: unprocessedKeys
        } as unknown as Result

        function unexpectedError() {
            return internalError("Unexpected error: Responses is undefined").withContext("batchGet", {options})
        }
    }

    /**
     * Run DynamoDB BatchGetItem command. This is similar to {@link DynamoDB.batchWrite} but limited to just one table and also better typed.
     * @param items - batch items
     * @param options - command options
     */
    async batchWrite<O extends BatchWriteOptions>(items: input.BatchWriteItem<Key, NonKey>[], options?: O) {
        interface Result extends BatchConsumedCapacity<O>, ddb.__MetadataBearer, UnprocessedItems<Key, NonKey> {
        }

        const batch = new BatchWriteBuilder(this.ctx);
        this.builder.batchWrite(batch).add(items)
        if (options !== undefined) {
            batch.options(options)
        }
        const response = await batch.exec()
        return response as unknown as Result
    }

    /**
     * Create transaction builder for the table.
     * @param tx - transaction builder
     */
    with(tx: TransactWriteBuilder): input.TableTransactWrite<Key, NonKey>

    /**
     * Create transaction builder for the table.
     * @param tx - transaction builder
     */
    with(tx: TransactGetBuilder): input.TableTransactGet<Key, NonKey>
    /**
     * Create batch builder for the table.
     * @param batch - batch operation builder
     */
    with(batch: BatchWriteBuilder): input.TableBatchWrite<Key, NonKey>
    /**
     * Create batch builder for the table.
     * @param batch - batch operation builder
     */
    with(batch: BatchGetBuilder): input.TableBatchGet<Key, NonKey>
    with(tx: TransactGetBuilder | TransactWriteBuilder | BatchWriteBuilder | BatchGetBuilder) {
        if (tx instanceof TransactGetBuilder) return this.builder.transactGet(tx)
        if (tx instanceof TransactWriteBuilder) return this.builder.transactWrite(tx)
        if (tx instanceof BatchWriteBuilder) return this.builder.batchWrite(tx)
        return this.builder.batchGet(tx)
    }

    private handleDynamoException<T>(e: any, context: string, input: any) {
        const {ctx: {unmarshallOptions}} = this
        if (e instanceof ddb.ConditionalCheckFailedException) {
            const failedAttributes = e.Item !== undefined ? unmarshall(e.Item, unmarshallOptions) : undefined;
            return {
                FailedAttributes: failedAttributes as DDB.Id<Key & NonKey>,
                ConditionCheckFailed: true
            }
        }
        throw errorWithContext(e, context, {input})
    }
}

export type GetOptions<T> = T extends DDBTable<infer Key, infer NonKey> ? input.GetOptions<Key, NonKey> : never
export type DeleteOptions<T, V = {}> = T extends DDBTable<infer Key, infer NonKey> ? input.DeleteOptions<Key, NonKey, V> : never
export type PutOptions<T, V = {}> = T extends DDBTable<infer Key, infer NonKey> ? input.PutOptions<Key, NonKey, V> : never
export type UpdateOptions<T, V = {}> = T extends DDBTable<infer Key, infer NonKey> ? input.UpdateOptions<Key, NonKey, V> : never
export type QueryOptions<T, V = {}> = T extends DDBTable<infer Key, infer NonKey> ? input.QueryOptions<Key, NonKey, V> : never
export type ScanOptions<T, V = {}> = T extends DDBTable<infer Key, infer NonKey> ? input.ScanOptions<Key, NonKey, V> : never

export type TransactWrite<T> = T extends DDBTable<infer Key, infer NonKey> ? input.TableTransactWrite<Key, NonKey> : never
export type TransactGet<T> = T extends DDBTable<infer Key, infer NonKey> ? input.TableTransactGet<Key, NonKey> : never
export type TransactWriteItem<T, V = {}> = T extends DDBTable<infer Key, infer NonKey> ? input.TransactWriteItem<Key, NonKey, V> : never
export type TransactGetItem<T> = T extends DDBTable<infer Key, infer NonKey> ? input.TransactGetItem<Key, NonKey> : never

export type KeyType<T> = T extends DDBTable<infer Key, infer _NonKey> ? Key : never
export type NonKeyType<T> = T extends DDBTable<infer _Key, infer NonKey> ? NonKey : never
export type ItemType<T> = T extends DDBTable<infer Key, infer NonKey> ? DDB.Id<Key & NonKey> : never

export type ConditionCheck<T, V = unknown> = T extends DDBTable<infer Key, infer NonKey> ? input.ConditionGenerator<Key, NonKey, DDB.Id<Key & NonKey> & V> : never
export type Projection<T> = T extends DDBTable<infer Key, infer NonKey> ? input.ProjectionGenerator<Key, NonKey> : never
export type KeyCondition<T, V = unknown> = T extends DDBTable<infer Key, infer NonKey> ? input.KeyConditionGenerator<Key, DDB.Id<Key & NonKey> & V> : never
export type FilterCondition<T, V = unknown> = T extends DDBTable<infer Key, infer NonKey> ? input.FilterConditionGenerator<Key, NonKey, DDB.Id<Key & NonKey> & V> : never

interface Attributes<Key, NonKey, O extends input.HasReturnValue> {
    //<!-- @formatter:off -->
    Attributes: O['return'] extends 'ALL_OLD' ? (DDB.Id<Key & NonKey>) | undefined
              : O['return'] extends 'ALL_NEW' ? (DDB.Id<Key & NonKey>)
              : O['return'] extends 'UPDATED_OLD' ? Partial<NonKey> | undefined
              : O['return'] extends 'UPDATED_NEW' ? Partial<NonKey>
              : O['return'] extends string ? Partial<DDB.Id<Key & NonKey>>
              : O['return'] extends string | undefined ? Partial<DDB.Id<Key & NonKey>> | undefined
              : never
    //<!-- @formatter:on -->
}

//<!-- @formatter:off -->
interface CheckFailedAttributes<Key, NonKey, O extends input.HasCondition<Key, NonKey>> {
    FailedAttributes: O['returnOnConditionFailure'] extends 'ALL_OLD' ? (DDB.Id<Key & NonKey>) | undefined
                    : O['returnOnConditionFailure'] extends 'ALL_NEW' ? (DDB.Id<Key & NonKey>)
                    : O['returnOnConditionFailure'] extends 'UPDATED_OLD' ? Partial<NonKey> | undefined
                    : O['returnOnConditionFailure'] extends 'UPDATED_NEW' ? Partial<NonKey>
                    : O['returnOnConditionFailure'] extends 'NONE' ? never
                    : O['returnOnConditionFailure'] extends string ? Partial<DDB.Id<Key & NonKey>>
                    : O['returnOnConditionFailure'] extends string | undefined ? Partial<DDB.Id<Key & NonKey>> | undefined
                    : never
}
//<!-- @formatter:on -->

interface HasProjection {
    projection?: Function
}

interface Item<Key, NonKey, O extends HasProjection> {
    //<!-- @formatter:off -->
    Item?: O['projection'] extends Function | undefined ? Partial<(DDB.Id<Key & NonKey>)> : (DDB.Id<Key & NonKey>)
    //<!-- @formatter:on -->
}

interface BatchResponses<Key, NonKey, O extends HasProjection> {
    //<!-- @formatter:off -->
    Responses: O['projection'] extends Function ? Partial<(DDB.Id<Key & NonKey>)>[] : (DDB.Id<Key & NonKey>)[]
    UnprocessedKeys: (Key)[]
    //<!-- @formatter:on -->
}

interface UnprocessedItems<Key, NonKey> {
    //<!-- @formatter:off -->
    UnprocessedItems: (DDB.Id<Key & NonKey>)[]
    //<!-- @formatter:on -->
}

interface HasItemCollectionMetrics {
    returnItemCollectionMetrics?: ddb.ReturnItemCollectionMetrics
}

interface ItemCollectionMetrics<O extends HasItemCollectionMetrics> {
    //<!-- @formatter:off -->
    ItemCollectionMetrics: O['returnItemCollectionMetrics'] extends 'NONE' ? never
                         : O['returnItemCollectionMetrics'] extends string ? ddb.ItemCollectionMetrics
                         : O['returnItemCollectionMetrics'] extends string | undefined ? ddb.ItemCollectionMetrics | undefined
                         : never
    //<!-- @formatter:on -->
}

interface ConsumedCapacity<O extends input.HasConsumedCapacity> {
    //<!-- @formatter:off -->
    ConsumedCapacity: O['returnConsumedCapacity'] extends 'NONE' ? never
                    : O['returnConsumedCapacity'] extends string ? ddb.ConsumedCapacity
                    : O['returnConsumedCapacity'] extends string | undefined ? ddb.ConsumedCapacity | undefined
                    : never
    //<!-- @formatter:on -->
}

interface BatchConsumedCapacity<O extends input.HasConsumedCapacity> {
    //<!-- @formatter:off -->
    ConsumedCapacity: O['returnConsumedCapacity'] extends 'NONE' ? never
                    : O['returnConsumedCapacity'] extends string ? ddb.ConsumedCapacity[]
                    : O['returnConsumedCapacity'] extends string | undefined ? ddb.ConsumedCapacity[] | undefined
                    : never
    //<!-- @formatter:on -->
}
