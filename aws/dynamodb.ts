import * as aws from "@pulumi/aws";
import {newPolicy} from "@aws/util";

const data = new aws.dynamodb.Table('data', {
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
    }]
}, {retainOnDelete: true});

const sessions = new aws.dynamodb.Table('sessions', {
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
    ttl: {attributeName: 'refresh_token_expires_at', enabled: true}
});

const locks = new aws.dynamodb.Table('locks', {
    attributes: [
        {name: 'pk', type: 'S'},
    ],
    hashKey: 'pk',
    billingMode: 'PAY_PER_REQUEST',
    ttl: {attributeName: 'ttl', enabled: true}
});

const users = new aws.dynamodb.Table('users', {
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
}, {retainOnDelete: true});

export const dataTable = {
    arn: data.arn,
    name: data.name
}
export const sessionsTable = {
    arn: sessions.arn,
    name: sessions.name
}
export const locksTable = {
    arn: locks.arn,
    name: locks.name
}
export const usersTable = {
    arn: users.arn,
    name: users.name
}

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
