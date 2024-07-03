import {OpenAPIBuilder} from "@app/lambda";
import Bill from "@src/billntip/bill-paths";
import Tip from "@src/billntip/tip-paths";

export default function (api: OpenAPIBuilder) {
    api.paths({...Bill, ...Tip}).spec = {
        'POST /tip/registration': {
            description: `
Verify user attributes and add user into receivers group. Being in receivers group allow user to receive tips from other user. 
            `
        },
        'POST /bill/{orgId}/member': {
            description: `
Invites user to join the organisation. Caller must be the organisation admin. What happens depends on the invited user status:
* If user does not exist then new user created and invited. Invite email will have a link to start a signup flow. At the end of the flow, after user provides all the necessary information they presented with a prompt to join the organisation. 
* If user does exist but not confirmed then re-send invitation email.
* If user exists and confirmed then send an email with a link opening prompt screen asking if user would like to join the organisation. 
            `
        }
    }
}
