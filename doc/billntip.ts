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
        'POST /bill/{orgId}/members': {
            description: `
Invites user to join the organisation. Caller must be the organisation admin. What happens depends on the invited user status:
* If user does not exist then new user created and invited. Invite email will have a link to start a signup flow. At the end of the flow, after user provides all the necessary information they presented with a prompt to join the organisation. 
* If user does exist but not confirmed then re-send invitation email.
* If user exists and confirmed then send an email with a link opening prompt screen asking if user would like to join the organisation. 
            `
        },
        'DELETE /bill/{orgId}/locations/{id}': {
            description: `
Move location into the archive. Archived locations can be accessed using \`GET\` requests either by specifying location 
id or by adding \`archived\` to the query string. Location is moved back from archive when it is updated using 
\`PUT /bill/{orgId}/locations/{id}\`.
            `
        },
        'POST /pay/card': {
            description: `
Starts card tokenization process. Entire tokenization process is described in pseudocode below.

\`\`\`js
async function createEmptyCard() {
    return await post("/tip/card", {
        body:{
            currency: "EUR",
            type: "CB_VISA_MASTERCARD"
        }
    })
}

async function tokenizeCard(tokenization: any) {
    const response = await post(tokenization.url, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            'accessKeyRef': tokenization.access_key,
            'data': tokenization.data,
            'cardNumber': '4970107111111119',
            'cardExpirationDate': '1235',
            'cardCvx': '123',
        })
    })
    const bodyText = await response.text()
    if (response.status >= 300) {
        throw bodyText
    }
    return bodyText
}

async function updateCard(cardId: string, token: string) {
    return await put({
        id: registrationId,
        token,
        cardholder_name: "Andrei Verbin"
    })
}

try {
    const emptyCard = await createEmptyCard()    
    const token = await tokenizeCard(emptyCard.tokenization)    
    const updatedRegistration = await updateCard(emptyCard.id, token)    
} catch (e) {
    console.log("Error", JSON.stringify(e))
}         
\`\`\`        
`
        }
    }
}
