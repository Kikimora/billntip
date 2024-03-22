import * as aws from "@pulumi/aws";
import {newPolicy} from "@aws/util";

const data = new aws.dynamodb.Table('data', {
    attributes: [
        {name: 'pk', type: 'S'},
        {name: 'sk', type: 'S'},
        {name: 'uid', type: 'S'}
    ],
    hashKey: 'pk',
    rangeKey: 'sk',
    billingMode: 'PAY_PER_REQUEST',
    globalSecondaryIndexes: [{
        name: "business_users",
        hashKey: "uid",
        rangeKey: "sk",
        projectionType: "ALL"
    }]
});

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

export function allowCrud() {
    return newPolicy('DynamoDbAccess')
        .allow("dynamodb:GetItem",
            "dynamodb:DeleteItem",
            "dynamodb:PutItem",
            "dynamodb:Scan",
            "dynamodb:Query",
            "dynamodb:UpdateItem",
            "dynamodb:DescribeTable")
}
