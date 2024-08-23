import * as ddb from "@aws-sdk/client-dynamodb";
import {Type} from ".";
import dynamodb from "./commands";
import {schema} from "./schema";

const Sessions = {
    name: "sessions",
    key: {"session_id": Type.String},
    attributes: {
        name: Type.String,
        age: Type.Number,
        lock: Type.String
    }
} as const satisfies schema.TableSchema

const DynamoDB = dynamodb()
const SessionsTable = DynamoDB.table(Sessions).forKey<{ session_id: `SESSION ${string}` }>()

beforeEach(function () {
    jest.clearAllMocks()
})

type UpdateFn = (args: ddb.UpdateItemCommandInput) => Promise<ddb.UpdateItemOutput>
const update = jest.spyOn(ddb.DynamoDB.prototype, 'updateItem') as unknown as jest.MockedFunction<UpdateFn>
describe("Update Command", () => {

    beforeEach(function () {
        update.mockResolvedValue({})
    })

    it("requires key", async () => {
        await SessionsTable.update({session_id: "SESSION ID"}, {})
        expect(update).toHaveBeenCalledWith({
            TableName: "sessions",
            Key: {session_id: {S: 'SESSION ID'}},
            ExpressionAttributeValues: undefined,
            ExpressionAttributeNames: undefined,
        })
    })

    it("expose key and values to expressions and generates attribute names and values", async () => {
        await SessionsTable.update({session_id: "SESSION ID"}, {
                values: {lockValue: "ABC", newSession: "NEW SESSION"},
                expression: ({key, attr, ref}) =>
                    `SET ${key.session_id}=${ref('newSession')}, ${attr.lock}=${ref('lockValue')}`,
                condition: ({key: {session_id}, attr: {lock}, ref}) =>
                    `${lock} = ${ref('lockValue')}, ${session_id} = ${ref('session_id')}`,
            }
        )
        expect(update).toHaveBeenCalledWith(expect.objectContaining({
            UpdateExpression: 'SET #session_id=:newSession, #lock=:lockValue',
            ConditionExpression: '#lock = :lockValue, #session_id = :session_id',
            ExpressionAttributeValues: {
                ':lockValue': {S: 'ABC'},
                ':newSession': {S: 'NEW SESSION'},
                ':session_id': {S: 'SESSION ID'}
            },
            ExpressionAttributeNames: {
                '#lock': 'lock',
                "#session_id": "session_id"
            },
        }))
    })
    it("expose all other update item command properties", async () => {
        await SessionsTable.update({session_id: "SESSION ID"}, {
            expression: () => "SET lock=1",
            return: "ALL_NEW",
            returnOnConditionFailure: "ALL_OLD",
            returnCollectionMetrics: "SIZE",
            returnConsumedCapacity: "TOTAL"
        })
        expect(update).toHaveBeenCalledWith(expect.objectContaining({
            ReturnValues: "ALL_NEW",
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            ReturnItemCollectionMetrics: "SIZE",
            ReturnConsumedCapacity: "TOTAL",
        }))
    })

    it("accept expression object", async () => {
        await SessionsTable.update({session_id: "SESSION ID"}, {
                values: {age: 30},
                expression: ({attr, ref}) => ({
                    set: {
                        [attr.age]: ref('age'),
                        [attr.name]: ref.val("New Name"),
                    }
                }),
            }
        )
        expect(update).toHaveBeenCalledWith(expect.objectContaining({
            UpdateExpression: "SET #age = :age, #name = :__val1",
            ExpressionAttributeValues: {
                ':age': {N: '30'},
                ':__val1': {S: 'New Name'}
            },
            ExpressionAttributeNames: {
                '#age': 'age',
                "#name": "name"
            },
        }))
    })
})

type PutItemFn = (args: ddb.PutItemCommandInput) => Promise<ddb.PutItemOutput>
const putItem = jest.spyOn(ddb.DynamoDB.prototype, 'putItem') as unknown as jest.MockedFunction<PutItemFn>
describe("Put Command", () => {

    beforeEach(function () {
        putItem.mockResolvedValue({})
    })

    it("requires key and item", async () => {
        await SessionsTable.put({session_id: "SESSION ID"}, {
                item: {name: "Hello", age: 10}
            }
        )
        expect(putItem).toHaveBeenCalledWith(expect.objectContaining({
            Item: {
                session_id: {S: 'SESSION ID'},
                name: {S: "Hello"},
                age: {N: "10"}
            },
            ExpressionAttributeValues: undefined,
            ExpressionAttributeNames: undefined,
        }))
    })

    it("expose key and values to condition expression and generates attribute names and values", async () => {
        await SessionsTable.put({session_id: "SESSION ID"}, {
                item: {name: "Hello", age: 10},
                values: {lockValue: "ABC"},
                condition: ({key: {session_id}, attr: {lock, name, age}, ref}) =>
                    `${lock} = ${ref('lockValue')} AND ${session_id} = ${ref('session_id')} AND ${name}='A' AND ${age}=10`,
            }
        )
        expect(putItem).toHaveBeenCalledWith(expect.objectContaining({
            ConditionExpression: '#lock = :lockValue AND #session_id = :session_id AND #name=\'A\' AND #age=10',
            ExpressionAttributeValues: {
                ':session_id': {S: 'SESSION ID'},
                ':lockValue': {S: 'ABC'}
            },
            ExpressionAttributeNames: {
                '#name': 'name',
                '#age': 'age',
                "#session_id": "session_id",
                '#lock': "lock"
            },
        }))
    })

    it("expose all other put item command properties", async () => {
        await SessionsTable.put({session_id: "SESSION ID"}, {
                item: {},
                return: "ALL_NEW",
                returnOnConditionFailure: "ALL_OLD",
                returnCollectionMetrics: "SIZE",
                returnConsumedCapacity: "TOTAL"
            }
        )
        expect(putItem).toHaveBeenCalledWith(expect.objectContaining({
            ReturnValues: "ALL_NEW",
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            ReturnItemCollectionMetrics: "SIZE",
            ReturnConsumedCapacity: "TOTAL",
        }))
    })
})

type DeleteItemFn = (args: ddb.DeleteItemCommandInput) => Promise<ddb.DeleteItemOutput>
const deleteItem = jest.spyOn(ddb.DynamoDB.prototype, 'deleteItem') as unknown as jest.MockedFunction<DeleteItemFn>
describe("Delete Command", () => {

    beforeEach(function () {
        deleteItem.mockResolvedValue({})
    })

    it("requires key", async () => {
        await SessionsTable.delete({session_id: "SESSION ID"})
        expect(deleteItem).toHaveBeenCalledWith(expect.objectContaining({
            Key: {session_id: {S: 'SESSION ID'}},
            ExpressionAttributeValues: undefined,
            ExpressionAttributeNames: undefined,
        }))
    })

    it("expose key and values to condition expression and generates attribute names and values", async () => {
        await SessionsTable.delete({session_id: "SESSION ID"}, {
                values: {lockValue: "ABC"},
                condition: ({key: {session_id}, attr: {lock, name, age}, ref}) =>
                    `${lock} = ${ref('lockValue')} AND ${session_id} = ${ref('session_id')} AND ${name}='A' AND ${age}=10`,
            }
        )
        expect(deleteItem).toHaveBeenCalledWith(expect.objectContaining({
            ConditionExpression: '#lock = :lockValue AND #session_id = :session_id AND #name=\'A\' AND #age=10',
            ExpressionAttributeValues: {
                ':session_id': {S: 'SESSION ID'},
                ':lockValue': {S: 'ABC'}
            },
            ExpressionAttributeNames: {
                '#name': 'name',
                '#age': 'age',
                "#session_id": "session_id",
                '#lock': "lock"
            },
        }))
    })

    it("expose all other delete item command properties", async () => {
        await SessionsTable.delete({session_id: "SESSION ID"}, {
                return: "ALL_NEW",
                returnItemsCollectionMetrics: "SIZE",
                returnOnConditionFailure: "ALL_OLD",
                returnConsumedCapacity: "TOTAL"
            }
        )
        expect(deleteItem).toHaveBeenCalledWith(expect.objectContaining({
            ReturnValues: "ALL_NEW",
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            ReturnItemCollectionMetrics: "SIZE",
            ReturnConsumedCapacity: "TOTAL",
        }))
    })
})

type GetItemFn = (args: ddb.GetItemCommandInput) => Promise<ddb.GetItemOutput>
const getItem = jest.spyOn(ddb.DynamoDB.prototype, 'getItem') as unknown as jest.MockedFunction<GetItemFn>
describe("Get Command", () => {

    beforeEach(function () {
        getItem.mockResolvedValue({})
    })

    it("requires key", async () => {
        await SessionsTable.get({session_id: "SESSION ID"})
        expect(getItem).toHaveBeenCalledWith(expect.objectContaining({
            TableName: SessionsTable.name,
            Key: {session_id: {S: 'SESSION ID'}},
            ExpressionAttributeNames: undefined,
            ProjectionExpression: undefined
        }))
    })

    it("expose table attributes to projection expression and generates attribute names", async () => {
        await SessionsTable.get({session_id: "SESSION ID"}, {
                projection: ({key: {session_id}, attr: {name, age}}) =>
                    [`${session_id}`, `${name}`, `${age}`],
            }
        )
        expect(getItem).toHaveBeenCalledWith(expect.objectContaining({
            ProjectionExpression: '#session_id, #name, #age',
            ExpressionAttributeNames: {
                '#name': 'name',
                '#age': 'age',
                "#session_id": "session_id"
            },
        }))
    })

    it("expose all other get item command properties", async () => {
        await SessionsTable.get({session_id: "SESSION ID"}, {
                consistentRead: true,
                returnConsumedCapacity: "TOTAL"
            }
        )
        expect(getItem).toHaveBeenCalledWith(expect.objectContaining({
            ConsistentRead: true,
            ReturnConsumedCapacity: "TOTAL",
        }))
    })
})

type BatchGetItemFn = (args: ddb.BatchGetItemCommandInput) => Promise<ddb.BatchGetItemOutput>
const batchGetItem = jest.spyOn(ddb.DynamoDB.prototype, 'batchGetItem') as unknown as jest.MockedFunction<BatchGetItemFn>
describe("Batch Get Command", () => {
    beforeEach(function () {
        batchGetItem.mockResolvedValue({})
    })

    it("builds batch get command", async () => {
        const T1 = DynamoDB.table({
            name: "Table1", key: {id: Type.Number}, attributes: {}
        })
        const T3 = DynamoDB.table({
            name: "Table2", key: {session_id: Type.String} as const, attributes: {} as const
        })
        const batch = DynamoDB.batchGet()
        SessionsTable.with(batch).get([{session_id: "SESSION 1"}, {session_id: "SESSION 2"}], {
            projection: ({key, attr}) => [`${key.session_id}`, `${attr.name}`, `${attr.age}`],
            consistentRead: false
        })
        T1.with(batch).get([{id: 1}], {
            projection: ({key}) => [`${key.id}`],
            consistentRead: true
        })
        T3.with(batch).get([{session_id: "1"}, {session_id: "2"}])
        await batch.returnConsumedCapacity("INDEXES").exec()
        expect(batchGetItem).toHaveBeenCalledWith(expect.objectContaining({
            ReturnConsumedCapacity: "INDEXES",
            RequestItems: {
                [SessionsTable.name]: {
                    Keys: [{session_id: {S: "SESSION 1"}}, {session_id: {S: "SESSION 2"}}],
                    ProjectionExpression: "#session_id, #name, #age",
                    ExpressionAttributeNames: {
                        "#session_id": "session_id",
                        "#name": "name",
                        "#age": "age",
                    },
                    ConsistentRead: false,
                },
                [T1.name]: {
                    Keys: [{id: {N: "1"}}],
                    ProjectionExpression: "#id",
                    ExpressionAttributeNames: {
                        "#id": "id",
                    },
                    ConsistentRead: true,
                },
                [T3.name]: {
                    Keys: [{session_id: {S: "1"}}, {session_id: {S: "2"}}],
                    ExpressionAttributeNames: undefined,
                    ConsistentRead: undefined,
                },
            },
        }))
    })

    it("overwrites items coming from the same table", async () => {

        const batch = DynamoDB.batchGet()
        SessionsTable.with(batch).get([{session_id: "SESSION 1"}], {
            projection: ({key}) => [`${key.session_id}`],
            consistentRead: false
        })
        SessionsTable.with(batch).get([{session_id: "SESSION 2"}], {
            projection: ({attr}) => [`${attr.name}`, `${attr.age}`],
            consistentRead: true
        })
        await batch.exec()
        expect(batchGetItem).toHaveBeenCalledWith(expect.objectContaining({
            RequestItems: {
                [SessionsTable.name]: {
                    Keys: [{session_id: {S: "SESSION 2"}}],
                    ProjectionExpression: "#name, #age",
                    ExpressionAttributeNames: {
                        "#name": "name",
                        "#age": "age",
                    },
                    ConsistentRead: true,
                }
            },
        }))
    })
})

type TransactGetItemsFn = (args: ddb.TransactGetItemsCommandInput) => Promise<ddb.TransactGetItemsOutput>
const transactGetItems = jest.spyOn(ddb.DynamoDB.prototype, 'transactGetItems') as unknown as jest.MockedFunction<TransactGetItemsFn>
describe("Transact Get Command", () => {

    beforeEach(function () {
        transactGetItems.mockResolvedValue({Responses: []})
    })

    it("builds transact get command", async () => {
        const Another = DynamoDB.table({name: "Another", key: {id: Type.Number}, attributes: {}})

        const tx = DynamoDB.transactGet()
        SessionsTable.with(tx).get({session_id: "SESSION 1"}, {
            projection: ({key, attr}) => [`${key.session_id}`, `${attr.name}`, `${attr.age}`],
        })
        Another.with(tx).get({id: 1}, {
            projection: ({key}) => [`${key.id}`],
        })
        SessionsTable.with(tx).get({session_id: "SESSION 2"})
        await tx.returnConsumedCapacity("INDEXES").exec()
        expect(transactGetItems).toHaveBeenCalledWith(expect.objectContaining({
            ReturnConsumedCapacity: "INDEXES",
            TransactItems: [
                {
                    Get: {
                        TableName: SessionsTable.name,
                        Key: {session_id: {S: "SESSION 1"}},
                        ProjectionExpression: "#session_id, #name, #age",
                        ExpressionAttributeNames: {
                            "#session_id": "session_id",
                            "#name": "name",
                            "#age": "age",
                        }
                    }
                },
                {
                    Get: {
                        TableName: Another.name,
                        Key: {id: {N: "1"}},
                        ProjectionExpression: "#id",
                        ExpressionAttributeNames: {"#id": "id"}
                    }
                },
                {
                    Get: {
                        TableName: SessionsTable.name,
                        Key: {session_id: {S: "SESSION 2"}},
                        ProjectionExpression: undefined,
                        ExpressionAttributeNames: undefined
                    }
                },
            ]
        }))
    })
})

type BatchWriteItemFn = (args: ddb.BatchWriteItemCommandInput) => Promise<ddb.BatchWriteItemOutput>
const batchWriteItem = jest.spyOn(ddb.DynamoDB.prototype, 'batchWriteItem') as unknown as jest.MockedFunction<BatchWriteItemFn>
describe("Batch Write Command", () => {

    beforeEach(function () {
        batchWriteItem.mockResolvedValue({})
    })

    it("builds batch write command", async () => {
        const Another = DynamoDB.table({name: "Another", key: {id: Type.Number}, attributes: {}})
        const tx = DynamoDB.batchWrite()
        SessionsTable.with(tx).put({session_id: "SESSION 1"}, {}).delete({session_id: "SESSION 2"})
        Another.with(tx).add([{action: "put", key: {id: 1}, item: {}}])
        await tx.returnConsumedCapacity("INDEXES")
            .returnItemCollectionMetrics("SIZE")
            .exec()
        expect(batchWriteItem).toHaveBeenCalledWith(expect.objectContaining({
            ReturnConsumedCapacity: "INDEXES",
            ReturnItemCollectionMetrics: "SIZE",
            RequestItems: {
                [SessionsTable.name]: [
                    {PutRequest: {Item: {"session_id": {S: "SESSION 1"}}}},
                    {DeleteRequest: {Key: {"session_id": {S: "SESSION 2"}}}}],
                [Another.name]: [
                    {PutRequest: {Item: {"id": {N: "1"}}}}
                ]
            }
        }))
    })
})

type TransactWriteItemsFn = (args: ddb.TransactWriteItemsCommandInput) => Promise<ddb.TransactWriteItemsOutput>
const transactWriteItems = jest.spyOn(ddb.DynamoDB.prototype, 'transactWriteItems') as unknown as jest.MockedFunction<TransactWriteItemsFn>
describe("Transact Write Command", () => {

    beforeEach(function () {
        transactWriteItems.mockResolvedValue({})
    })

    it("builds transact write command", async () => {
        const Another = DynamoDB.table({name: "Another", key: {id: Type.Number}, attributes: {}})
        const tx = DynamoDB.transactWrite()
        SessionsTable.with(tx).put({session_id: "SESSION 1"}, {
            item: {age: 10, name: "Andrey"},
            values: {lockValue: "1"},
            condition: ({key, attr, ref}) => `${key.session_id}=1 AND ${attr.lock} = ${ref('lockValue')}`,
            returnOnConditionFailure: "ALL_OLD",
        }).update({session_id: "SESSION 1"}, {
            values: {age: 10, name: "Andrey", lockValue: "1"},
            expression: ({attr, ref}) => `SET ${attr.name} = ${ref('name')}, ${attr.age} = ${ref('age')}`,
            condition: ({attr, ref}) => `${attr.lock} = ${ref('lockValue')}`,
            returnOnConditionFailure: "ALL_OLD",
        })
        Another.with(tx).exec({id: 1}, {
            action: "delete",
            values: {lock: "1"},
            condition: ({ref}) => `${ref('lock')} = 2`,
            returnOnConditionFailure: "ALL_OLD",
        })
        SessionsTable.with(tx).exec({session_id: "SESSION 2"}, {
            action: "check",
            values: {lock: "1"},
            condition: ({attr, ref}) => `${attr.lock} = ${ref('lock')}`,
            returnOnConditionFailure: "ALL_OLD",
        })
        await tx.returnConsumedCapacity("INDEXES")
            .returnItemCollectionMetrics("SIZE")
            .clientRequestToken("Idempotency token")
            .exec()
        expect(transactWriteItems).toHaveBeenCalledWith(expect.objectContaining({
                ReturnConsumedCapacity: "INDEXES",
                ReturnItemCollectionMetrics: "SIZE",
                ClientRequestToken: "Idempotency token",
                TransactItems: [
                    {
                        Put: {
                            TableName: SessionsTable.name,
                            Item: {
                                session_id: {S: "SESSION 1"},
                                age: {N: "10"},
                                name: {S: "Andrey"}
                            },
                            ConditionExpression: "#session_id=1 AND #lock = :lockValue",
                            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                            ExpressionAttributeNames: {
                                "#session_id": "session_id",
                                "#lock": "lock",
                            },
                            ExpressionAttributeValues: {
                                ":lockValue": {S: "1"}
                            },
                        }
                    },
                    {
                        Update: {
                            TableName: SessionsTable.name,
                            Key: {session_id: {S: "SESSION 1"}},
                            UpdateExpression: "SET #name = :name, #age = :age",
                            ConditionExpression: "#lock = :lockValue",
                            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                            ExpressionAttributeNames: {
                                "#name": "name",
                                "#age": "age",
                                "#lock": "lock",
                            },
                            ExpressionAttributeValues: {
                                ":lockValue": {S: "1"},
                                ":name": {S: "Andrey"},
                                ":age": {N: "10"},
                            },
                        }
                    },
                    {
                        Delete: {
                            TableName: Another.name,
                            Key: {id: {N: "1"}},
                            ConditionExpression: ":lock = 2",
                            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                            ExpressionAttributeNames: undefined,
                            ExpressionAttributeValues: {
                                ":lock": {S: "1"}
                            },
                        }
                    },
                    {
                        ConditionCheck: {
                            TableName: SessionsTable.name,
                            Key: {session_id: {S: "SESSION 2"}},
                            ConditionExpression: "#lock = :lock",
                            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                            ExpressionAttributeNames: {
                                "#lock": "lock"
                            },
                            ExpressionAttributeValues: {
                                ":lock": {S: "1"}
                            },
                        }
                    },
                ]
            }
        ))
    })
})

type QueryFn = (args: ddb.QueryCommandInput) => Promise<ddb.QueryOutput>
const query = jest.spyOn(ddb.DynamoDB.prototype, 'query') as unknown as jest.MockedFunction<QueryFn>
describe("Query Command", () => {

    beforeEach(function () {
        query.mockResolvedValue({Items:[]})
    })

    it("expose attributes to expressions", async () => {
        await SessionsTable.query({
            values: {session_id: "ABC", sid: "XYZ", name: "Andrey"},
            keyCondition: ({key, ref}) => `${key.session_id} >= ${ref('sid')}`,
            filter: ({attr, ref}) => `${attr.name} = ${ref('name')}`,
            projection: ({key: {session_id}, attr: {name, age}}) =>
                [session_id, name, age],
        })
        expect(query).toHaveBeenCalledWith(expect.objectContaining({
            KeyConditionExpression: "#session_id >= :sid",
            FilterExpression: "#name = :name",
            ProjectionExpression: '#session_id, #name, #age',
            ExpressionAttributeNames: {
                '#name': 'name',
                "#session_id": "session_id",
                "#age": "age"
            },
            ExpressionAttributeValues: {
                ':sid': {S: "XYZ"},
                ':name': {S: "Andrey"}
            },
        }))
    })

    it("expose all other get item command properties", async () => {
        const Index = DynamoDB.table({
            name: Sessions.name,
            key: Sessions.key,
            attributes: Sessions.attributes,
            index: "Index"
        })
        await Index.query({
                select: "ALL_PROJECTED_ATTRIBUTES",
                limit: 10,
                scanIndexForward: true,
                consistentRead: true,
                returnConsumedCapacity: "TOTAL"
            },
            {session_id: "Session"})
        expect(query).toHaveBeenCalledWith(expect.objectContaining({
            Select: "ALL_PROJECTED_ATTRIBUTES",
            Limit: 10,
            ScanIndexForward: true,
            IndexName: "Index",
            ExclusiveStartKey: {"session_id": {S: "Session"}},
            ConsistentRead: true,
            ReturnConsumedCapacity: "TOTAL",
        }))
    })
})

type ScanFn = (args: ddb.ScanCommandInput) => Promise<ddb.ScanOutput>
const scan = jest.spyOn(ddb.DynamoDB.prototype, 'scan') as unknown as jest.MockedFunction<ScanFn>
describe("Scan Command", () => {
    beforeEach(function () {
        scan.mockResolvedValue({Items:[]})
    })

    it("expose attributes to expressions", async () => {
        await SessionsTable.scan({
                values: {session_id: "ABC", sid: "XYZ", name: "Andrey"},
                filter: ({attr, ref}) => `${attr.name} = ${ref('name')}`,
                projection: ({key: {session_id}, attr: {name, age}}) =>
                    [session_id, name, age],
            }
        )
        expect(scan).toHaveBeenCalledWith(expect.objectContaining({
            FilterExpression: "#name = :name",
            ProjectionExpression: '#session_id, #name, #age',
            ExpressionAttributeNames: {
                '#name': 'name',
                "#session_id": "session_id",
                "#age": "age"
            },
            ExpressionAttributeValues: {
                ':name': {S: "Andrey"}
            },
        }))
    })

    it("expose all other get item command properties", async () => {
        const Index = DynamoDB.table({
            name: SessionsTable.name,
            key: SessionsTable.schema.key,
            attributes: SessionsTable.schema.attributes,
            index: "Secondary"
        })
        await Index.scan({
                select: "ALL_PROJECTED_ATTRIBUTES",
                limit: 10,
                segment: 1,
                totalSegments: 10,
                consistentRead: true,
                returnConsumedCapacity: "TOTAL",
            },
            {session_id: "Session"}
        )
        expect(scan).toHaveBeenCalledWith(expect.objectContaining({
            IndexName: "Secondary",
            Select: "ALL_PROJECTED_ATTRIBUTES",
            Limit: 10,
            Segment: 1,
            TotalSegments: 10,
            ExclusiveStartKey: {"session_id": {S: "Session"}},
            ConsistentRead: true,
            ReturnConsumedCapacity: "TOTAL",
        }))
    })
})