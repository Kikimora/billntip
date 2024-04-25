//1. CORS in API GW
//2. Bucket website (index.js)
//3. User for nikita to upload files
//4. Recipient resource (First, Last name, Birth Day, Country of Residence)

import {
    Type,
    table,
    updateCommand,
    putCommand,
    getCommand,
    queryCommand, scanCommand, batchGet, batchWrite, deleteCommand, transactGet, transactWrite
} from "@app/dynamodb";
import {DynamoDB} from "@aws-sdk/client-dynamodb";

const Table = table("sessions",
    {"session_id": Type.String} as const,
    {
        name: Type.String,
        age: Type.Number,
        lock: Type.String
    } as const
)

describe("Update Command", () => {

    it("requires key", () => {
        const {input} = updateCommand(Table, {
                key: {session_id: "SESSION ID"},
            }
        )
        expect(input).toEqual(expect.objectContaining({
            TableName: "sessions",
            Key: {session_id: {S: 'SESSION ID'}},
            ExpressionAttributeValues: undefined,
            ExpressionAttributeNames: undefined,
        }))
    })

    it("expose key and values to expressions and generates attribute names and values", () => {
        const {input} = updateCommand(Table, {
                key: {session_id: "SESSION ID"},
                values: {lockValue: "ABC", newSession: "NEW SESSION"},
                expression: ({key, attr, val}) =>
                    `SET ${key.session_id}=${val.newSession}, ${attr.lock}=${val.lockValue}`,
                condition: ({key: {session_id}, attr: {lock}, val}) =>
                    `${lock} = ${val.lockValue}, ${session_id} = ${val.session_id}`,
            }
        )
        expect(input).toEqual(expect.objectContaining({
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
    it("expose all other update item command properties", () => {
        const {input} = updateCommand(Table, {
                key: {session_id: "SESSION ID"},
                expression: () => "SET lock=1",
                return: "ALL_NEW",
                returnOnConditionFailure: "ALL_OLD",
                returnCollectionMetrics: "SIZE",
                returnConsumedCapacity: "TOTAL"
            }
        )
        expect(input).toEqual(expect.objectContaining({
            ReturnValues: "ALL_NEW",
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            ReturnItemCollectionMetrics: "SIZE",
            ReturnConsumedCapacity: "TOTAL",
        }))
    })
})

describe("Put Command", () => {

    it("requires key and item", () => {
        const {input} = putCommand(Table, {
                key: {session_id: "SESSION ID"},
                item: {name: "Hello", age: 10}
            }
        )
        expect(input).toEqual(expect.objectContaining({
            Item: {
                session_id: {S: 'SESSION ID'},
                name: {S: "Hello"},
                age: {N: "10"}
            },
            ExpressionAttributeValues: undefined,
            ExpressionAttributeNames: undefined,
        }))
    })

    it("expose key and values to condition expression and generates attribute names and values", () => {
        const {input} = putCommand(Table, {
                key: {session_id: "SESSION ID"},
                item: {name: "Hello", age: 10},
                values: {lockValue: "ABC"},
                condition: ({key: {session_id}, attr: {lock, name, age}, val}) =>
                    `${lock} = ${val.lockValue} AND ${session_id} = ${val.session_id} AND ${name}='A' AND ${age}=10`,
            }
        )
        expect(input).toEqual(expect.objectContaining({
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

    it("expose all other put item command properties", () => {
        const {input} = putCommand(Table, {
                key: {session_id: "SESSION ID"},
                item: {},
                return: "ALL_NEW",
                returnOnConditionFailure: "ALL_OLD",
                returnCollectionMetrics: "SIZE",
                returnConsumedCapacity: "TOTAL"
            }
        )
        expect(input).toEqual(expect.objectContaining({
            ReturnValues: "ALL_NEW",
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            ReturnItemCollectionMetrics: "SIZE",
            ReturnConsumedCapacity: "TOTAL",
        }))
    })
})

describe("Delete Command", () => {

    it("requires key", () => {
        const {input} = deleteCommand(Table, {
                key: {session_id: "SESSION ID"},
            }
        )
        expect(input).toEqual(expect.objectContaining({
            Key: {session_id: {S: 'SESSION ID'}},
            ExpressionAttributeValues: undefined,
            ExpressionAttributeNames: undefined,
        }))
    })

    it("expose key and values to condition expression and generates attribute names and values", () => {
        const {input} = deleteCommand(Table, {
                key: {session_id: "SESSION ID"},
                values: {lockValue: "ABC"},
                condition: ({key: {session_id}, attr: {lock, name, age}, val}) =>
                    `${lock} = ${val.lockValue} AND ${session_id} = ${val.session_id} AND ${name}='A' AND ${age}=10`,
            }
        )
        expect(input).toEqual(expect.objectContaining({
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

    it("expose all other delete item command properties", () => {
        const {input} = deleteCommand(Table, {
                key: {session_id: "SESSION ID"},
                return: "ALL_NEW",
                returnItemsCollectionMetrics: "SIZE",
                returnOnConditionFailure: "ALL_OLD",
                returnConsumedCapacity: "TOTAL"
            }
        )
        expect(input).toEqual(expect.objectContaining({
            ReturnValues: "ALL_NEW",
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            ReturnItemCollectionMetrics: "SIZE",
            ReturnConsumedCapacity: "TOTAL",
        }))
    })
})

describe("Get Command", () => {

    it("requires key", () => {
        const {input} = getCommand(Table, {
                key: {session_id: "SESSION ID"}
            }
        )
        expect(input).toEqual(expect.objectContaining({
            TableName: Table.name,
            Key: {session_id: {S: 'SESSION ID'}},
            ExpressionAttributeNames: undefined,
            ProjectionExpression: undefined
        }))
    })

    it("expose table attributes to projection expression and generates attribute names", () => {
        const {input} = getCommand(Table, {
                key: {session_id: "SESSION ID"},
                projection: ({key: {session_id}, attr: {name, age}}) =>
                    [`${session_id}`, `${name}`, `${age}`],
            }
        )
        expect(input).toEqual(expect.objectContaining({
            ProjectionExpression: '#session_id, #name, #age',
            ExpressionAttributeNames: {
                '#name': 'name',
                '#age': 'age',
                "#session_id": "session_id"
            },
        }))
    })

    it("expose all other get item command properties", () => {
        const {input} = getCommand(Table, {
                key: {session_id: "SESSION ID"},
                consistentRead: true,
                returnConsumedCapacity: "TOTAL"
            }
        )
        expect(input).toEqual(expect.objectContaining({
            ConsistentRead: true,
            ReturnConsumedCapacity: "TOTAL",
        }))
    })
})

describe("Batch Get Command", () => {

    it("builds batch get command", () => {
        const Table1 = table("Table1", {id: Type.Number} as const, {} as const)
        const Table2 = table("Table2", {session_id: Type.String} as const, {} as const)
        const {input} = batchGet()
            .add(Table, {
                keys: [{session_id: "1"}, {session_id: "2"}],
                projection: ({key, attr}) => [`${key.session_id}`, `${attr.name}`, `${attr.age}`],
                consistentRead: false
            })
            .add(Table1, {
                keys: [{id: 1}],
                projection: ({key}) => [`${key.id}`],
                consistentRead: true
            })
            .add(Table2, {
                keys: [{session_id: "1"}, {session_id: "2"}]
            })
            .returnConsumedCapacity("INDEXES")
            .command()

        expect(input).toEqual(expect.objectContaining({
            ReturnConsumedCapacity: "INDEXES",
            RequestItems: {
                [Table.name]: {
                    Keys: [{session_id: {S: "1"}}, {session_id: {S: "2"}}],
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

    it("merges items coming from the same table", () => {
        const {input} = batchGet()
            .add(Table, {
                keys: [{session_id: "1"}],
                projection: ({key}) => [`${key.session_id}`],
                consistentRead: false
            })
            .add(Table, {
                keys: [{session_id: "2"}],
                projection: ({attr}) => [`${attr.name}`, `${attr.age}`],
                consistentRead: true
            })
            .command()

        expect(input).toEqual(expect.objectContaining({
            RequestItems: {
                [Table.name]: {
                    Keys: [{session_id: {S: "2"}}, {session_id: {S: "1"}}],
                    ProjectionExpression: "#name, #age, #session_id",
                    ExpressionAttributeNames: {
                        "#session_id": "session_id",
                        "#name": "name",
                        "#age": "age",
                    },
                    ConsistentRead: true,
                }
            },
        }))

    })
})

describe("Transact Get Command", () => {
    it("builds transact get command", () => {
        const AnotherTable = table("Another", {id: Type.Number} as const, {} as const)
        const {input} = transactGet()
            .add(Table, {
                key: {session_id: "1"},
                projection: ({key, attr}) => [`${key.session_id}`, `${attr.name}`, `${attr.age}`],
            })
            .add(AnotherTable, {
                key: {id: 1},
                projection: ({key}) => [`${key.id}`],
            })
            .add(Table, {key: {session_id: "2"}})
            .returnConsumedCapacity("INDEXES")
            .command()

        expect(input).toEqual(expect.objectContaining({
            ReturnConsumedCapacity: "INDEXES",
            TransactItems: [
                {
                    Get: {
                        TableName: Table.name,
                        Key: {session_id: {S: "1"}},
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
                        TableName: AnotherTable.name,
                        Key: {id: {N: "1"}},
                        ProjectionExpression: "#id",
                        ExpressionAttributeNames: {"#id": "id"}
                    }
                },
                {
                    Get: {
                        TableName: Table.name,
                        Key: {session_id: {S: "2"}},
                        ProjectionExpression: undefined,
                        ExpressionAttributeNames: undefined
                    }
                },
            ]
        }))
    })
})

describe("Batch Write Command", () => {

    it("builds batch write command", () => {

        const AnotherTable = table("Another", {id: Type.Number} as const, {} as const)
        const {input} = batchWrite()
            .add(Table, [
                {action: "put", key: {session_id: "1"}, item: {}},
                {action: "delete", key: {session_id: "2"}}
            ])
            .add(AnotherTable, [
                {action: "put", key: {id: 1}, item: {}}
            ])
            .returnConsumedCapacity("INDEXES")
            .returnItemCollectionMetrics("SIZE")
            .command()

        expect(input).toEqual(expect.objectContaining({
            ReturnConsumedCapacity: "INDEXES",
            ReturnItemCollectionMetrics: "SIZE",
            RequestItems: {
                [Table.name]: [
                    {PutRequest: {Item: {"session_id": {S: "1"}}}},
                    {DeleteRequest: {Key: {"session_id": {S: "2"}}}}],
                [AnotherTable.name]: [
                    {PutRequest: {Item: {"id": {N: "1"}}}}
                ]
            }
        }))
    })
})

describe("Transact Write Command", () => {

    it("builds transact write command", () => {

        const AnotherTable = table("Another", {id: Type.Number} as const, {} as const)
        const {input} = transactWrite()
            .add(Table, {
                action: "put",
                key: {session_id: "1"},
                item: {age: 10, name: "Andrey"},
                values: {lockValue: "1"},
                condition: ({key, attr, val}) => `${key.session_id}=1 AND ${attr.lock} = ${val.lockValue}`,
                returnOnConditionFailure: "ALL_OLD",
            })
            .add(Table, {
                action: "update",
                key: {session_id: "1"},
                values: {age: 10, name: "Andrey", lockValue: "1"},
                expression: ({attr, val}) => `SET ${attr.name} = ${val.name}, ${attr.age} = ${val.age}`,
                condition: ({attr, val}) => `${attr.lock} = ${val.lockValue}`,
                returnOnConditionFailure: "ALL_OLD",
            })
            .add(AnotherTable, {
                action: "delete",
                key: {id: 1},
                values: {lock: "1"},
                condition: ({val}) => `${val.lock} = 2`,
                returnOnConditionFailure: "ALL_OLD",
            })
            .add(Table, {
                action: "check",
                key: {session_id: "2"},
                values: {lock: "1"},
                condition: ({attr, val}) => `${attr.lock} = ${val.lock}`,
                returnOnConditionFailure: "ALL_OLD",
            })
            .returnConsumedCapacity("INDEXES")
            .returnItemCollectionMetrics("SIZE")
            .clientRequestToken("Idempotency token")
            .command()

        expect(input).toEqual(expect.objectContaining({
                ReturnConsumedCapacity: "INDEXES",
                ReturnItemCollectionMetrics: "SIZE",
                ClientRequestToken: "Idempotency token",
                TransactItems: [
                    {
                        Put: {
                            TableName: Table.name,
                            Item: {
                                session_id: {S: "1"},
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
                            TableName: Table.name,
                            Key: {session_id: {S: "1"}},
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
                            TableName: AnotherTable.name,
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
                            TableName: Table.name,
                            Key: {session_id: {S: "2"}},
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
            })
        )
    })
})


describe("Query Command", () => {

    it("expose attributes to expressions", () => {
        const {input} = queryCommand(Table, {
                values: {session_id: "ABC", sid: "XYZ", name: "Andrey"},
                keyCondition: ({key, val}) => `${key.session_id} >= ${val.sid}`,
                filter: ({attr, val}) => `${attr.name} = ${val.name}`,
                projection: ({key: {session_id}, attr: {name, age}}) =>
                    `${session_id}, ${name}, ${age}`,
            }
        )
        expect(input).toEqual(expect.objectContaining({
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

    it("expose all other get item command properties", () => {
        const {input} = queryCommand(Table, {
                select: "ALL_PROJECTED_ATTRIBUTES",
                limit: 10,
                scanIndexForward: true,
                indexName: "Index",
                exclusiveStartKey: {session_id: "Session"},
                consistentRead: true,
                returnConsumedCapacity: "TOTAL"
            }
        )
        expect(input).toEqual(expect.objectContaining({
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

describe("Scan Command", () => {

    it("expose attributes to expressions", () => {
        const {input} = scanCommand(Table, {
                values: {session_id: "ABC", sid: "XYZ", name: "Andrey"},
                filter: ({attr, val}) => `${attr.name} = ${val.name}`,
                projection: ({key: {session_id}, attr: {name, age}}) =>
                    `${session_id}, ${name}, ${age}`,
            }
        )
        expect(input).toEqual(expect.objectContaining({
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

    it("expose all other get item command properties", () => {
        const {input} = scanCommand(Table, {
                indexName: "Secondary",
                select: "ALL_PROJECTED_ATTRIBUTES",
                limit: 10,
                segment: 1,
                totalSegments: 10,
                exclusiveStartKey: {session_id: "Session"},
                consistentRead: true,
                returnConsumedCapacity: "TOTAL",
            }
        )
        expect(input).toEqual(expect.objectContaining({
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