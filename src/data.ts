import {Type, SchemaType, table, TableSchema} from "@app/dynamodb";
import _ from "lodash";
import {KeySchema, Table} from "@app/dynamodb/schema";

const DataTable = process.env.TABLE ?? _.throw("TABLE required")

const key = {
    pk: Type.String,
    sk: Type.String, //TODO template literal type here e.g. `business#${id}`,
} as const;

type XXX = SchemaType<{
    pk: "S",
    sk: "S",
    xx: "XXX" | "AAA" | `b_${string}`,
}>

type X = `aaa_${string}`

const xxx1: XXX = {
    pk: "qq",
    sk: "qq",
    xx: "AAA"
}

export const Business = table(DataTable, {
    pk: Type.String as `b_${string}`,
    sk: Type.String as "business"
}, {
    //business cannot spam invites
    maxInvites: Type.Number,
    remainingInvites: Type.Number, // remainingInvites = MIN(maxInvites, (now - lastInviteTs)/recharge speed - 1)
    lastInviteTs: Type.Number
})

export const Managers = table(DataTable, {
    pk: Type.String as `b_${string}`,
    sk: Type.String as `manager_${string}`
}, {
    uid: Type.String,  //uid, trigger item addition into the business_users GSI
    role: Type.String,
})

export const ManagersIndex = table(DataTable, {
    uid: Type.String as `u_${string}`,
    sk: Type.String as `manager_${string}`
}, {
    pk: Type.String as `b_${string}`,
    role: Type.String,
})

export const Invites = table(DataTable, {
    pk: Type.String as `b_${string}`,
    sk: Type.String as `i_${string}`
}, {
    uid: Type.String,       //uid, trigger item addition into the business_users GSI
    invited_at: Type.Number,
    accepted_at: Type.Number,
    team: Type.String
})

// b_${id}, emp_${uid}
// u_{uid}, emp_${uid} - business_users GSI
export const Employees = table(DataTable, {
    pk: Type.String as `b_${string}`,
    sk: Type.String as `emp_${string}`
}, {
    uid: Type.String,       //uid, trigger item addition into the business_users GSI
    invited_at: Type.Number,
    accepted_at: Type.Number,
    team: Type.String
})

// b_${id}, p_${ulid}
export const Payouts = table(DataTable, key, {
    team: Type.String,
    ts: Type.Number,
    totalAmount: Type.Number,
    currency: Type.String,
})

// b_${id}, e_{type}_{ulid}
// type - emp, p
// u_{uid}, e_{type}_{ulid} - business_users GSI
export const BusinessEvents = table(DataTable, key, {
    uid: Type.String,    //uid, trigger item addition into the business_users GSI
    ts: Type.Number,
    //emp - Employee
    status: Type.String, //Accepted, Terminated
    //p - Payout
    amount: Type.Number
})

// u_#{id}, 'user'
export const Users = table(DataTable, key, {
    mangoPayUid: Type.String
})
// u_#{id}, 'settings'
// u_#{id}, 'profile'
