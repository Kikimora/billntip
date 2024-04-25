import * as ddb from "@aws-sdk/client-dynamodb";
import {marshall} from "@aws-sdk/util-dynamodb";
import {KeySchema, TableType, SchemaType, ProjectionGenerator} from "./schema";
import {MarshalOptions, prepareCommand} from "./util";
import _ from "lodash";

/**
 * DynamoDb {@link ddb.KeysAndAttributes} for a given {@link Table}
 */
export interface BatchGetItem<Table> {
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
export interface BatchGetBuilder {
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

type KeysAndAttributes = Omit<ddb.KeysAndAttributes, 'ProjectionExpression'> & { ProjectionExpression?: string[] }

/**
 * Create a builder for {@link ddb.BatchGetItemCommandInput} and {@link ddb.BatchGetItemCommand}
 */
export function batchGet(): BatchGetBuilder {
    const items: Record<string, KeysAndAttributes> = {}
    let returnConsumedCapacity: ddb.ReturnConsumedCapacity | undefined

    const builder: BatchGetBuilder = {
        add<T extends TableType<T>>(tbl: T, item: BatchGetItem<T>) {
            const {
                attributeNames,
                key,
                attr,
            } = prepareCommand(tbl, undefined);
            const {projection} = item
            const exp = items[tbl.name] ?? {}
            let consistentRead
            if (item.consistentRead !== undefined || exp.ConsistentRead !== undefined) {
                //Beware of the edge case:
                //true      || undefined === true
                //false     || undefined === undefined, but we want false
                //undefined || undefined === undefined
                consistentRead = item.consistentRead || (exp.ConsistentRead ?? false)
            }
            let projectionExpression = projection?.({key, attr})
            if (projectionExpression !== undefined || exp.ProjectionExpression !== undefined) {
                projectionExpression = (projectionExpression ?? []).concat(exp.ProjectionExpression ?? [])
            }
            let expressionAttributeNames
            if (!_.isEmpty(attributeNames) || exp.ExpressionAttributeNames !== undefined) {
                expressionAttributeNames = {...attributeNames, ...exp.ExpressionAttributeNames}
            }
            items[tbl.name] = {
                Keys: item.keys.map(x => marshall(x, MarshalOptions)).concat(exp.Keys ?? []),
                ConsistentRead: consistentRead,
                ProjectionExpression: projectionExpression,
                ExpressionAttributeNames: expressionAttributeNames
            }
            return builder
        },
        returnConsumedCapacity(capacity: ddb.ReturnConsumedCapacity) {
            returnConsumedCapacity = capacity
            return builder
        },
        input() {
            return {
                RequestItems: _.mapValues(items, (x) => {
                    let projectionExpression;
                    if (x.ProjectionExpression !== undefined) {
                        projectionExpression = _.uniq(x.ProjectionExpression).join(', ')
                    }
                    let expressionAttributeNames = x.ExpressionAttributeNames
                    if (_.isEmpty(expressionAttributeNames)) expressionAttributeNames = undefined
                    return {
                        ...x,
                        ProjectionExpression: projectionExpression
                    }
                }),
                ReturnConsumedCapacity: returnConsumedCapacity
            };
        },
        command() {
            return new ddb.BatchGetItemCommand(this.input())
        }
    }

    return builder
}
