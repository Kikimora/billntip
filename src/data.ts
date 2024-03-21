import {D, table} from "@app/dynamodb";
import _ from "lodash";

const DataTable = process.env.TABLE ?? _.throw("TABLE required")

const key = {
    pk: D.String,
    sk: D.String //TODO template literal type here e.g. `business#${id}`
} as const;

export const Keys = {
    business(id: string) {
        return {pk: `b_${id}`}
    },
    employee(businessId: string, userId: string) {
        return {
            pk: `b_${businessId}`,
            sk: `u_${userId}`
        }
    },
    businessEvent(businessId: string, ts: number) {
        return {
            pk: `b_${businessId}`,
            sk: ts.toString()
        }
    },
    user(id: string) {
        return {pk: `u_${id}`}
    },
}

// b_${id}, 'business'
export const Business = table(DataTable, key, {
    //business cannot spam invites
    maxInvites: D.Number,
    remainingInvites: D.Number, // remainingInvites = MIN(maxInvites, (now - lastInviteTs)/recharge speed - 1)
    lastInviteTs: D.Number
})

// b_${id}, emp_${uid}
// u_{uid}, emp_${uid} - business_users GSI
export const Employees = table(DataTable, key, {
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
