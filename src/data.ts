import {D, SchemaType, table, TableSchema} from "@app/dynamodb";
import _ from "lodash";
import {KeySchema, Table} from "@app/dynamodb/schema";

const DataTable = process.env.TABLE ?? _.throw("TABLE required")

const key = {
    pk: D.String,
    sk: D.String, //TODO template literal type here e.g. `business#${id}`,
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
    pk: D.String as `b_${string}`,
    sk: D.String as "business"
}, {
    //business cannot spam invites
    maxInvites: D.Number,
    remainingInvites: D.Number, // remainingInvites = MIN(maxInvites, (now - lastInviteTs)/recharge speed - 1)
    lastInviteTs: D.Number
})

export const Managers = table(DataTable, {
    pk: D.String as `b_${string}`,
    sk: D.String as `manager_${string}`
}, {
    uid: D.String,  //uid, trigger item addition into the business_users GSI
    role: D.String,
})

export const ManagersIndex = table(DataTable, {
    uid: D.String as `u_${string}`,
    sk: D.String as `manager_${string}`
}, {
    pk: D.String as `b_${string}`,
    role: D.String,
})

export const Invites = table(DataTable, {
    pk: D.String as `b_${string}`,
    sk: D.String as `i_${string}`
}, {
    uid: D.String,       //uid, trigger item addition into the business_users GSI
    invited_at: D.Number,
    accepted_at: D.Number,
    team: D.String
})

// b_${id}, emp_${uid}
// u_{uid}, emp_${uid} - business_users GSI
export const Employees = table(DataTable, {
    pk: D.String as `b_${string}`,
    sk: D.String as `emp_${string}`
}, {
    uid: D.String,       //uid, trigger item addition into the business_users GSI
    invited_at: D.Number,
    accepted_at: D.Number,
    team: D.String
})

// b_${id}, p_${ulid}
export const Payouts = table(DataTable, key, {
    team: D.String,
    ts: D.Number,
    totalAmount: D.Number,
    currency: D.String,
})

// b_${id}, e_{type}_{ulid}
// type - emp, p
// u_{uid}, e_{type}_{ulid} - business_users GSI
export const BusinessEvents = table(DataTable, key, {
    uid: D.String,    //uid, trigger item addition into the business_users GSI
    ts: D.Number,
    //emp - Employee
    status: D.String, //Accepted, Terminated
    //p - Payout
    amount: D.Number
})

// u_#{id}, 'user'
export const Users = table(DataTable, key, {
    mangoPayUid: D.String
})
// u_#{id}, 'settings'
// u_#{id}, 'profile'
