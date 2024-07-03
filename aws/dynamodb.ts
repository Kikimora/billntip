import * as aws from "@pulumi/aws";
import {newPolicy} from "@aws/util";
import {tags, stack, configFolder} from "@aws/config";
import * as pulumi from "@pulumi/pulumi";

const data = new aws.dynamodb.Table('data', {
    name: `billntip-${stack}-data`,
    attributes: [
        {name: 'pk', type: 'S'},
        {name: 'sk', type: 'S'}
    ],
    hashKey: 'pk',
    rangeKey: 'sk',
    billingMode: 'PAY_PER_REQUEST',
    globalSecondaryIndexes: [{
        name: "inverse",
        hashKey: "sk",
        rangeKey: "pk",
        projectionType: "KEYS_ONLY"
    }],
    tags,
    deletionProtectionEnabled: true
}, {retainOnDelete: true});

const sessions = new aws.dynamodb.Table('sessions', {
    name: `billntip-${stack}-sessions`,
    // TODO set TTL for records in this table.
    attributes: [
        {name: 'session_id', type: 'S'},
        // {name: 'access_token', type: 'S'},
        // {name: 'id_token', type: 'S'},
        // {name: 'refresh_token', type: 'S'},
        // {name: 'expires_at', type: 'N'},
        // {name: 'session_expires_at', type: 'N'},
        // {name: 'salt', type: 'S'},
        // {name: 'lock', type: 'S'},
        // {name: 'lock_till', type: 'N'}
    ],
    hashKey: 'session_id',
    billingMode: 'PAY_PER_REQUEST',
    ttl: {attributeName: 'refresh_token_expires_at', enabled: true},
    tags
});

const locks = new aws.dynamodb.Table('locks', {
    name: `billntip-${stack}-locks`,
    attributes: [
        {name: 'pk', type: 'S'},
    ],
    hashKey: 'pk',
    billingMode: 'PAY_PER_REQUEST',
    ttl: {attributeName: 'ttl', enabled: true},
    tags
});

const users = new aws.dynamodb.Table('users', {
    name: `billntip-${stack}-users`,
    attributes: [
        {name: 'pk', type: 'S'},
        {name: 'sk', type: 'S'},
        {name: 'name', type: 'S'},
        {name: 'value', type: 'S'}
    ],
    hashKey: 'pk',
    rangeKey: 'sk',
    billingMode: 'PAY_PER_REQUEST',
    globalSecondaryIndexes: [
        //Map <attr name, attr value> to a username
        {
            name: "user_attributes",
            hashKey: "name",
            rangeKey: "value",
            projectionType: "KEYS_ONLY"
        }],
    tags,
    deletionProtectionEnabled: true
}, {retainOnDelete: true});

export const DynamoDbCRUDActions = ["dynamodb:GetItem",
    "dynamodb:DeleteItem",
    "dynamodb:PutItem",
    "dynamodb:Scan",
    "dynamodb:Query",
    "dynamodb:UpdateItem",
    "dynamodb:DescribeTable"]

export function allowCrud() {
    return newPolicy()
        .allow(...DynamoDbCRUDActions)
}

const config = new aws.ssm.Parameter("dynamodb-config", {
    name: `${configFolder}/dynamodb`,
    type: "String",
    value: pulumi.jsonStringify({
        sessions: sessions.name,
        users: users.name,
        locks: locks.name,
        data: data.name
    })
})

export default {
    dataTable: {
        arn: data.arn,
        name: data.name
    },
    sessionsTable: {
        arn: sessions.arn,
        name: sessions.name
    },
    locksTable: {
        arn: locks.arn,
        name: locks.name
    },
    usersTable: {
        arn: users.arn,
        name: users.name
    },
    config: config.arn
}