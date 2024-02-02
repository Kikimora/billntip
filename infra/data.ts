import * as aws from "@pulumi/aws";

export const dataTable = new aws.dynamodb.Table('data', {
    attributes: [
        {name: 'pk', type: 'S'},
        {name: 'sk', type: 'S'}
    ],
    hashKey: 'pk',
    rangeKey: 'sk',
    billingMode: 'PAY_PER_REQUEST',
});

export const sessionsTable = new aws.dynamodb.Table('sessions', {
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
    ttl: {attributeName: 'session_expires_at', enabled: true}
});
