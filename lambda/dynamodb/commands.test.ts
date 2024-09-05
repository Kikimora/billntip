import * as ddb from "@aws-sdk/client-dynamodb";
import * as DDB from "./commands";

const DynamoDB = DDB.dynamodb()
const SessionSchema = {
    key: DDB.Key({
        "session_id": DDB.TemplateLiteral([DDB.Literal("SESSION "), DDB.String])
    }),
    item: DDB.Item({
        name: DDB.String,
        age: DDB.Number,
        lock: DDB.Optional(DDB.String)
    })
} as const
const SessionsTable = DynamoDB.table("sessions", SessionSchema)

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
        await SessionsTable.update({
            key: {session_id: "SESSION ID"},
            expression() {
                return ""
            }
        })
        expect(update).toHaveBeenCalledWith(expect.objectContaining({
            TableName: "sessions",
            Key: {session_id: {S: 'SESSION ID'}},
            ExpressionAttributeValues: undefined,
            ExpressionAttributeNames: undefined,
        }))
    })

    it("expose key and values to expressions and generates attribute names and values", async () => {
        await SessionsTable.update({
                key: {session_id: "SESSION ID"},
                expression: ({key, attr, ref}) =>
                    `SET ${key.session_id}=${ref('newSession')}, ${attr.lock}=${ref('lockValue')}`,
                condition: ({key: {session_id}, attr: {lock}, ref}) =>
                    `${lock} = ${ref('lockValue')}, ${session_id} = ${ref('session_id')}`,
            }, {lockValue: "ABC", newSession: "NEW SESSION"}
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
        await SessionsTable.update({
            key: {session_id: "SESSION ID"},
            expression: () => "SET lock=1",
            return: "ALL_NEW",
            returnOnConditionFailure: "ALL_OLD",
            returnItemCollectionMetrics: "SIZE",
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
        await SessionsTable.update({
                key: {session_id: "SESSION ID"},
                expression: ({attr, ref}) => ({
                    set: {
                        [attr.age]: ref('age'),
                        [attr.name]: ref.val("New Name"),
                    }
                }),
            }, {age: 30}
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

    it("unmarshall attributes", async () => {
        update.mockResolvedValueOnce({
            Attributes: {
                lock: {S: "ABC"}
            }
        })
        const x: any = await SessionsTable.update({
            key: {session_id: "SESSION ID"},
            return: "UPDATED_NEW",
            expression: ({key, attr, ref}) =>
                `SET ${key.session_id}=${ref('newSession')}, ${attr.lock}=${ref('lockValue')}`
        }, {lockValue: "ABC", newSession: "NEW SESSION"})
        expect(x.ConditionCheckFailed).toBeFalse()
        expect(x.Attributes).toEqual({lock: "ABC"})
    })

    it("handles condition failures", async () => {
        update.mockRejectedValue(new ddb.ConditionalCheckFailedException({
            $metadata: {},
            Item: {lock: {S: "ABC"}},
            message: "Ooops"
        }))

        const x: any = await SessionsTable.update({
            key: {session_id: "SESSION ID"},
            expression: ({key, attr, ref}) =>
                `SET ${key.session_id}=${ref('newSession')}, ${attr.lock}=${ref('lockValue')}`,
            condition: ({key: {session_id}, attr: {lock}, ref}) =>
                `${lock} = ${ref('lockValue')}, ${session_id} = ${ref('session_id')}`,
            returnOnConditionFailure: "ALL_OLD"
        }, {lockValue: "ABC", newSession: "NEW SESSION"})
        expect(x.ConditionCheckFailed).toBeTrue()
        expect(x.FailedAttributes).toEqual({lock: "ABC"})
    })
})

type PutItemFn = (args: ddb.PutItemCommandInput) => Promise<ddb.PutItemOutput>
const putItem = jest.spyOn(ddb.DynamoDB.prototype, 'putItem') as unknown as jest.MockedFunction<PutItemFn>
describe("Put Command", () => {

    beforeEach(function () {
        putItem.mockResolvedValue({})
    })

    it("requires key and item", async () => {
        await SessionsTable.put({
            key: {session_id: "SESSION ID"},
            item: {session_id: "SESSION ID", name: "Hello", age: 10}
        })
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
        await SessionsTable.put({
            item: {session_id: "SESSION ID", name: "Hello", age: 10},
            condition: ({key: {session_id}, attr: {lock, name, age}, ref}) =>
                `${lock} = ${ref('lockValue')} AND ${session_id} = ${ref('session_id')} AND ${name}='A' AND ${age}=10`,
        }, {lockValue: "ABC"})
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
        await SessionsTable.put({
            item: {
                session_id: "SESSION ID",
                name: "NAME",
                age: 30
            },
            return: "ALL_OLD",
            returnOnConditionFailure: "NONE",
            returnItemCollectionMetrics: "SIZE",
            returnConsumedCapacity: "TOTAL"
        })
        expect(putItem).toHaveBeenCalledWith(expect.objectContaining({
            ReturnValues: "ALL_OLD",
            ReturnValuesOnConditionCheckFailure: "NONE",
            ReturnItemCollectionMetrics: "SIZE",
            ReturnConsumedCapacity: "TOTAL",
        }))
    })

    it("unmarshall attributes", async () => {
        putItem.mockResolvedValueOnce({
            Attributes: {
                name: {S: "Hello"},
                age: {N: "10"},
                session_id: {S: "SESSION ID"},
            }
        })
        const item: DDB.ItemType<typeof SessionsTable> = {session_id: "SESSION ID", name: "Hello", age: 10};
        const x: any = await SessionsTable.put({
            item,
            return: "ALL_OLD",
        }, {lockValue: "ABC"})
        expect(x.ConditionCheckFailed).toBeFalse()
        expect(x.Attributes).toEqual(item)
    })

    it("handles condition failures", async () => {
        putItem.mockRejectedValue(new ddb.ConditionalCheckFailedException({
            $metadata: {},
            Item: {session_id: {S: "SESSION ID"}},
            message: "Ooops"
        }))

        const x: any = await SessionsTable.put({
            item: {session_id: "SESSION ID", name: "Peter", age: 10},
            returnOnConditionFailure: "ALL_OLD"
        }, {lockValue: "ABC", newSession: "NEW SESSION"})
        expect(x.ConditionCheckFailed).toBeTrue()
        expect(x.FailedAttributes).toEqual({session_id: "SESSION ID"})
    })
})

type DeleteItemFn = (args: ddb.DeleteItemCommandInput) => Promise<ddb.DeleteItemOutput>
const deleteItem = jest.spyOn(ddb.DynamoDB.prototype, 'deleteItem') as unknown as jest.MockedFunction<DeleteItemFn>
describe("Delete Command", () => {

    beforeEach(function () {
        deleteItem.mockResolvedValue({})
    })

    it("requires key", async () => {
        await SessionsTable.delete({key: {session_id: "SESSION ID"}})
        expect(deleteItem).toHaveBeenCalledWith(expect.objectContaining({
            Key: {session_id: {S: 'SESSION ID'}},
            ExpressionAttributeValues: undefined,
            ExpressionAttributeNames: undefined,
        }))
    })

    it("expose key and values to condition expression and generates attribute names and values", async () => {
        await SessionsTable.delete({
            key: {session_id: "SESSION ID"},
            condition: ({key: {session_id}, attr: {lock, name, age}, ref}) =>
                `${lock} = ${ref('lockValue')} AND ${session_id} = ${ref('session_id')} AND ${name}='A' AND ${age}=10`,
        }, {lockValue: "ABC"})
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
        await SessionsTable.delete({
                key: {session_id: "SESSION ID"},
                return: "NONE",
                returnItemCollectionMetrics: "SIZE",
                returnOnConditionFailure: "ALL_OLD",
                returnConsumedCapacity: "TOTAL"
            }
        )
        expect(deleteItem).toHaveBeenCalledWith(expect.objectContaining({
            ReturnValues: "NONE",
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            ReturnItemCollectionMetrics: "SIZE",
            ReturnConsumedCapacity: "TOTAL",
        }))
    })

    it("unmarshall attributes", async () => {
        deleteItem.mockResolvedValueOnce({
            Attributes: {
                session_id: {S: "SESSION ID"},
            }
        })
        const x = await SessionsTable.delete({key: {session_id: "SESSION ID"}})
        expect(x.ConditionCheckFailed).toBeFalse()
        expect(x.Attributes).toEqual({session_id: "SESSION ID"})
    })

    it("handles condition failures", async () => {
        deleteItem.mockRejectedValue(new ddb.ConditionalCheckFailedException({
            $metadata: {},
            Item: {session_id: {S: "SESSION ID"}},
            message: "Ooops"
        }))
        const x: any = await SessionsTable.delete({
            key: {session_id: "SESSION ID"},
            condition() {
                return ""
            },
            returnOnConditionFailure: "ALL_OLD"
        })
        expect(x.ConditionCheckFailed).toBeTrue()
        expect(x.FailedAttributes).toEqual({session_id: "SESSION ID"})
    })
})

type GetItemFn = (args: ddb.GetItemCommandInput) => Promise<ddb.GetItemOutput>
const getItem = jest.spyOn(ddb.DynamoDB.prototype, 'getItem') as unknown as jest.MockedFunction<GetItemFn>
describe("Get Command", () => {

    beforeEach(function () {
        getItem.mockResolvedValue({})
    })

    it("requires key", async () => {
        await SessionsTable.get({key: {session_id: "SESSION ID"}})
        expect(getItem).toHaveBeenCalledWith(expect.objectContaining({
            TableName: SessionsTable.name,
            Key: {session_id: {S: 'SESSION ID'}},
            ExpressionAttributeNames: undefined,
            ProjectionExpression: undefined
        }))
    })

    it("expose table attributes to projection expression and generates attribute names", async () => {
        await SessionsTable.get({
                key: {session_id: "SESSION ID"},
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
        await SessionsTable.get({
            key: {session_id: "SESSION ID"},
            consistentRead: true,
            returnConsumedCapacity: "TOTAL"
        })
        expect(getItem).toHaveBeenCalledWith(expect.objectContaining({
            ConsistentRead: true,
            ReturnConsumedCapacity: "TOTAL",
        }))
    })

    it("unmarshall attributes", async () => {
        getItem.mockResolvedValueOnce({
            Item: {
                session_id: {S: "SESSION ID"},
            }
        })
        const x = await SessionsTable.get({key: {session_id: "SESSION ID"}})
        expect(x.Item).toEqual({session_id: "SESSION ID"})
    })
})

type BatchGetItemFn = (args: ddb.BatchGetItemCommandInput) => Promise<ddb.BatchGetItemOutput>
const batchGetItem = jest.spyOn(ddb.DynamoDB.prototype, 'batchGetItem') as unknown as jest.MockedFunction<BatchGetItemFn>
describe("Batch Get Command", () => {
    beforeEach(function () {
        batchGetItem.mockResolvedValue({})
    })

    it("builds batch get command", async () => {
        const Table1 = DynamoDB.table("Table1", {
            key: DDB.Key({id: DDB.Number}), item: DDB.Item({})
        })
        const Table2 = DynamoDB.table("Table2", {
            key: DDB.Key({session_id: DDB.String}), item: DDB.Item({})
        })
        const batch = DynamoDB.batchGet()
        SessionsTable.with(batch).get({
            keys: [{session_id: "SESSION 1"}, {session_id: "SESSION 2"}],
            projection: ({key, attr}) => [`${key.session_id}`, `${attr.name}`, `${attr.age}`],
            consistentRead: false
        })
        Table1.with(batch).get({
            keys: [{id: 1}],
            projection: ({key}) => [`${key.id}`],
            consistentRead: true
        })
        Table2.with(batch).get({keys: [{session_id: "1"}, {session_id: "2"}]})
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
                [Table1.name]: {
                    Keys: [{id: {N: "1"}}],
                    ProjectionExpression: "#id",
                    ExpressionAttributeNames: {
                        "#id": "id",
                    },
                    ConsistentRead: true,
                },
                [Table2.name]: {
                    Keys: [{session_id: {S: "1"}}, {session_id: {S: "2"}}],
                    ExpressionAttributeNames: undefined,
                    ConsistentRead: undefined,
                },
            },
        }))
    })

    it("overwrites items coming from the same table", async () => {
        const batch = DynamoDB.batchGet()
        SessionsTable.with(batch).get({
            keys: [{session_id: "SESSION 1"}],
            projection: ({key}) => [`${key.session_id}`],
            consistentRead: false
        })
        SessionsTable.with(batch).get({
            keys: [{session_id: "SESSION 2"}],
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

    it("unmarshall attributes", async () => {
        batchGetItem.mockResolvedValueOnce({
            Responses: {
                [SessionsTable.name]: [{session_id: {S: "SESSION 1"}}]
            },
            UnprocessedKeys: {
                [SessionsTable.name]: {
                    Keys: [{session_id: {S: "SESSION 2"}}]
                }
            }
        })
        const batch = DynamoDB.batchGet()
        SessionsTable.with(batch).get({
            keys: [{session_id: "SESSION 1"}],
        })
        const x = await batch.exec()
        expect(x.Responses).toEqual({
            [SessionsTable.name]: [{session_id: "SESSION 1"}]
        })
        expect(x.UnprocessedKeys).toEqual({
            [SessionsTable.name]: {
                Keys: [{session_id: "SESSION 2"}]
            }
        })
    })
})

type TransactGetItemsFn = (args: ddb.TransactGetItemsCommandInput) => Promise<ddb.TransactGetItemsOutput>
const transactGetItems = jest.spyOn(ddb.DynamoDB.prototype, 'transactGetItems') as unknown as jest.MockedFunction<TransactGetItemsFn>
describe("Transact Get Command", () => {

    beforeEach(function () {
        transactGetItems.mockResolvedValue({Responses: []})
    })
    const Another = DynamoDB.table("Another", {key: DDB.Key({id: DDB.Number}), item: DDB.Item({})})

    it("builds transact get command", async () => {

        const tx = DynamoDB.transactGet()
        SessionsTable.with(tx).get({
            key: {session_id: "SESSION 1"},
            projection: ({key, attr}) => [`${key.session_id}`, `${attr.name}`, `${attr.age}`],
        })
        Another.with(tx).get({
            key: {id: 1},
            projection: ({key}) => [`${key.id}`],
        })
        SessionsTable.with(tx).get({key: {session_id: "SESSION 2"}})
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

    it("unmarshall attributes", async () => {
        transactGetItems.mockResolvedValueOnce({
            Responses: [{
                Item: {session_id: {S: "SESSION 1"}}
            }],
        })
        const tx = DynamoDB.transactGet()
        SessionsTable.with(tx).get({key: {session_id: "SESSION 1"}})
        const x = await tx.exec()
        expect(x.Responses).toEqual([{session_id: "SESSION 1"}])
    })

    it("unmarshall attributes of failed transaction", async () => {
        transactGetItems.mockRejectedValue(new ddb.TransactionCanceledException({
            message: "",
            $metadata: {},
            CancellationReasons: [{
                Code: "TransactionConflict",
                Message: "TransactionConflict",
                Item: {session_id: {S: "SESSION 1"}}
            }, {
                Code: "None",
                Message: "None"
            }, {
                Code: "None",
                Message: "None"
            }],
            Message: "Oops"
        }))
        const tx = DynamoDB.transactGet()
        const getSessions = SessionsTable.with(tx)
            .get({key: {session_id: "SESSION 1"}})
            .get({key: {session_id: "SESSION 1"}})
        Another.with(tx).get({
            key: {id: 1},
            projection: ({key}) => [`${key.id}`],
        })
        const task = tx.exec();
        await expect(task).rejects.toMatchObject({
            Outcomes: [{
                Code: "TransactionConflict",
                Message: "TransactionConflict",
                Item: {session_id: "SESSION 1"}
            }, {
                Code: "None",
                Message: "None"
            }, {
                Code: "None",
                Message: "None"
            }],
            Message: "Oops"
        })
        const error = await task.catch(x => x)
        if (DDB.isTransactionCancelled(error)) {
            expect(error.Outcomes).toHaveLength(3)
            expect(DDB.isTransactionConflict(error.Outcomes[0])).toBeTrue()
            expect(DDB.isTransactionConflict(error.Outcomes[1])).toBeFalse()
            expect(Array.from(getSessions.failures(error))).toEqual([{
                Code: "TransactionConflict",
                Message: "TransactionConflict",
                Item: {session_id: "SESSION 1"}
            }])
        } else {
            fail("Error: DDB.isTransactionCancelled")
        }
    })
})

type BatchWriteItemFn = (args: ddb.BatchWriteItemCommandInput) => Promise<ddb.BatchWriteItemOutput>
const batchWriteItem = jest.spyOn(ddb.DynamoDB.prototype, 'batchWriteItem') as unknown as jest.MockedFunction<BatchWriteItemFn>
describe("Batch Write Command", () => {

    beforeEach(function () {
        batchWriteItem.mockResolvedValue({})
    })

    it("builds batch write command", async () => {
        const Another = DynamoDB.table("Another", {key: DDB.Key({id: DDB.Number}), item: DDB.Item({})})
        const tx = DynamoDB.batchWrite()
        SessionsTable.with(tx)
            .put({session_id: "SESSION 1", name: "", age: 1})
            .delete({session_id: "SESSION 2"})
        Another.with(tx).add([{action: "put", item: {id: 1}}])
        await tx.returnConsumedCapacity("INDEXES")
            .returnItemCollectionMetrics("SIZE")
            .exec()
        expect(batchWriteItem).toHaveBeenCalledWith(expect.objectContaining({
            ReturnConsumedCapacity: "INDEXES",
            ReturnItemCollectionMetrics: "SIZE",
            RequestItems: {
                [SessionsTable.name]: [
                    {PutRequest: {Item: {"session_id": {S: "SESSION 1"}, "age": {"N": "1"}, "name": {"S": ""},}}},
                    {DeleteRequest: {Key: {"session_id": {S: "SESSION 2"}}}}],
                [Another.name]: [
                    {PutRequest: {Item: {"id": {N: "1"}}}}
                ]
            }
        }))
    })

    it("unmarshall unprocessed items", async () => {
        batchWriteItem.mockResolvedValueOnce({
            UnprocessedItems: {
                [SessionsTable.name]: [
                    {
                        PutRequest: {
                            Item: {session_id: {S: "SESSION 1"}, name: {S: "Peter"}, age: {N: "10"}}
                        }
                    },
                    {
                        DeleteRequest: {
                            Key: {session_id: {S: "SESSION 1"}}
                        }
                    }
                ]
            }
        })
        const batch = DynamoDB.batchWrite()
        SessionsTable.with(batch)
            .put({session_id: "SESSION 1", name: "Peter", age: 10})
            .add([{
                action: "delete",
                key: {session_id: "SESSION 1"}
            }])
        const x = await batch.exec()
        expect(x.UnprocessedItems).toEqual({
            [SessionsTable.name]: [
                {action: "put", item: {session_id: "SESSION 1", name: "Peter", age: 10}},
                {action: "delete", key: {session_id: "SESSION 1"}},
            ]
        })
    })
})

type TransactWriteItemsFn = (args: ddb.TransactWriteItemsCommandInput) => Promise<ddb.TransactWriteItemsOutput>
const transactWriteItems = jest.spyOn(ddb.DynamoDB.prototype, 'transactWriteItems') as unknown as jest.MockedFunction<TransactWriteItemsFn>
describe("Transact Write Command", () => {

    beforeEach(function () {
        transactWriteItems.mockResolvedValue({})
    })
    const Another = DynamoDB.table("Another", {key: DDB.Key({id: DDB.Number}), item: DDB.Item({})})
    it("builds transact write command", async () => {
        const tx = DynamoDB.transactWrite()
        SessionsTable.with(tx).put({
            item: {session_id: "SESSION 1", age: 10, name: "Andrey"},
            condition: ({key, attr, ref}) => `${key.session_id}=1 AND ${attr.lock} = ${ref('lockValue')}`,
            returnOnConditionFailure: "ALL_OLD",
        }, {lockValue: "1"}).update({
            key: {session_id: "SESSION 1"},
            expression: ({attr, ref}) => `SET ${attr.name} = ${ref('name')}, ${attr.age} = ${ref('age')}`,
            condition: ({attr, ref}) => `${attr.lock} = ${ref('lockValue')}`,
            returnOnConditionFailure: "ALL_OLD",
        }, {age: 10, name: "Andrey", lockValue: "1"})
        Another.with(tx).add({
            action: "delete",
            key: {id: 1},
            condition: ({ref}) => `${ref('lock')} = 2`,
            returnOnConditionFailure: "ALL_OLD",
        }, {lock: "1"})
        SessionsTable.with(tx).add({
            action: "check",
            key: {session_id: "SESSION 2"},
            condition: ({attr, ref}) => `${attr.lock} = ${ref('lock')}`,
            returnOnConditionFailure: "ALL_OLD",
        }, {lock: "1"})
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

    it("unmarshall attributes of failed transaction", async () => {
        transactWriteItems.mockRejectedValue(new ddb.TransactionCanceledException({
            message: "",
            $metadata: {},
            CancellationReasons: [{
                Code: "TransactionConflict",
                Message: "TransactionConflict",
                Item: {session_id: {S: "SESSION 1"}}
            }, {
                Code: "None",
                Message: "None"
            }, {
                Code: "None",
                Message: "None"
            }],
            Message: "Oops"
        }))
        const tx = DynamoDB.transactWrite()
        const updateSessions = SessionsTable.with(tx)
            .update({
                key: {session_id: "SESSION 1"},
                expression() {
                    return ''
                }
            })
            .delete({key: {session_id: "SESSION 1"}})
        Another.with(tx).put({
            item: {id: 1}
        })
        const task = tx.exec();
        await expect(task).rejects.toMatchObject({
            Outcomes: [{
                Code: "TransactionConflict",
                Message: "TransactionConflict",
                Item: {session_id: "SESSION 1"}
            }, {
                Code: "None",
                Message: "None"
            }, {
                Code: "None",
                Message: "None"
            }],
            Message: "Oops"
        })
        const error = await task.catch(x => x)
        if (DDB.isTransactionCancelled(error)) {
            expect(error.Outcomes).toHaveLength(3)
            expect(DDB.isTransactionConflict(error.Outcomes[0])).toBeTrue()
            expect(DDB.isTransactionConflict(error.Outcomes[1])).toBeFalse()
            expect(Array.from(updateSessions.failures(error))).toEqual([{
                Code: "TransactionConflict",
                Message: "TransactionConflict",
                Item: {session_id: "SESSION 1"}
            }])
        } else {
            fail("Error: DDB.isTransactionCancelled")
        }
    })
})

type QueryFn = (args: ddb.QueryCommandInput) => Promise<ddb.QueryOutput>
const query = jest.spyOn(ddb.DynamoDB.prototype, 'query') as unknown as jest.MockedFunction<QueryFn>
describe("Query Command", () => {

    beforeEach(function () {
        query.mockResolvedValue({Items: []})
    })

    it("expose attributes to expressions", async () => {
        await SessionsTable.query({
            keyCondition: ({key, ref}) => `${key.session_id} >= ${ref('sid')}`,
            filter: ({attr, ref}) => `${attr.name} = ${ref('name')}`,
            projection: ({key: {session_id}, attr: {name, age}}) =>
                [session_id, name, age],
        }, {session_id: "ABC", sid: "XYZ", name: "Andrey"})
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
        const Index = DynamoDB.table("sessions", {
            key: DDB.Key({
                "session_id": DDB.TemplateLiteral([DDB.Literal("SESSION "), DDB.String])
            }),
            item: DDB.Item({
                name: DDB.String,
                age: DDB.Number,
                lock: DDB.Optional(DDB.String)
            })
        }, "Index")
        await Index.query({
            keyCondition() {
                return ""
            },
            select: "ALL_PROJECTED_ATTRIBUTES",
            limit: 10,
            scanIndexForward: true,
            consistentRead: true,
            returnConsumedCapacity: "TOTAL",
            startKey: {session_id: "SESSION 1"}
        })
        expect(query).toHaveBeenCalledWith(expect.objectContaining({
            Select: "ALL_PROJECTED_ATTRIBUTES",
            Limit: 10,
            ScanIndexForward: true,
            IndexName: "Index",
            ExclusiveStartKey: {"session_id": {S: "SESSION 1"}},
            ConsistentRead: true,
            ReturnConsumedCapacity: "TOTAL",
        }))
    })

    it("unmarshall attributes", async () => {
        query.mockResolvedValueOnce({
            Items: [{session_id: {S: "SESSION 1"}}],
        })
        const x = await SessionsTable.query({
            keyCondition: () => ``,
        })
        expect(x.Items).toEqual([{session_id: "SESSION 1"}])
    })
})

type ScanFn = (args: ddb.ScanCommandInput) => Promise<ddb.ScanOutput>
const scan = jest.spyOn(ddb.DynamoDB.prototype, 'scan') as unknown as jest.MockedFunction<ScanFn>
describe("Scan Command", () => {
    beforeEach(function () {
        scan.mockResolvedValue({Items: []})
    })

    it("expose attributes to expressions", async () => {
        await SessionsTable.scan({
            filter: ({attr, ref}) => `${attr.name} = ${ref('name')}`,
            projection: ({key: {session_id}, attr: {name, age}}) =>
                [session_id, name, age],
        }, {session_id: "ABC", sid: "XYZ", name: "Andrey"})
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
        const Index = DynamoDB.table("sessions", {
            key: DDB.Key({
                "session_id": DDB.TemplateLiteral([DDB.Literal("SESSION "), DDB.String])
            }),
            item: DDB.Item({
                name: DDB.String,
                age: DDB.Number,
                lock: DDB.Optional(DDB.String)
            })
        }, "Secondary")
        await Index.scan({
            select: "ALL_PROJECTED_ATTRIBUTES",
            limit: 10,
            segment: 1,
            totalSegments: 10,
            consistentRead: true,
            returnConsumedCapacity: "TOTAL",
            startKey: {session_id: "SESSION 1"}
        })
        expect(scan).toHaveBeenCalledWith(expect.objectContaining({
            IndexName: "Secondary",
            Select: "ALL_PROJECTED_ATTRIBUTES",
            Limit: 10,
            Segment: 1,
            TotalSegments: 10,
            ExclusiveStartKey: {"session_id": {S: "SESSION 1"}},
            ConsistentRead: true,
            ReturnConsumedCapacity: "TOTAL",
        }))
    })

    it("unmarshall attributes", async () => {
        scan.mockResolvedValueOnce({
            Items: [{session_id: {S: "SESSION 1"}}],
        })
        const x = await SessionsTable.scan({})
        expect(x.Items).toEqual([{session_id: "SESSION 1"}])
    })
})