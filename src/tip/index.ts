import {pipeline} from '@app/lambda'


//1. POST invite - create invite
// - if user exists - send invite email
// - if user does not exist - AdminCreateUser with Custom Message trigger to built email with a link
//2.
//2. POST invite/{id} - accept invite
//3. POST signup
//3. POST signup/details


//AdminCreateUser sends invitation message with temp password and username
//AdminConfirmSignup either sends verification email or confirm user without presenting a code.
//SignUp - sends verification email.

//1. Admin Invite - send email with link.
//2. User set password
//3. User set required attributes
//4. User set optional attributes
//5. User accepts invite

//1. Initiate invite
// - AdminCreateUser with Custom Message trigger OR
// - Send email using SES
// - Create invite record with user id

//2. Open invite link - tip.billntip.com/invite/{id} OR tip.billntip.com/invite/{id}?code=XYZ&email=ABC
// - Save invite in local storage
// - Request tokens
// - If Tokens aren't present - perform login with email and code as password, then retry
// - If Tokens present:
// -   If user is in the recipients group - open 'accepts invite' screen
// -   If user is not in the recipient group - open 'required attributes' screen

//3. Login procedure described here - https://docs.aws.amazon.com/cognito/latest/developerguide/how-to-create-user-accounts.html#authentication-flow-for-create-user
// - Call InitiateAuth
// - Respond to challenges
// - Get id and access tokens
// - Call 'start session' API with access_token to get a session cookie.

//3. Alternative login procedure
// Save URL in local storage
// Redirect to cognitp hosted page.
// When cognito redirect back - restore URL from local stoage





//POST tip.billntip.com/profile

export const handler = pipeline()
    .do(async function (){})
    .requireLambdaAuth()
    .traceRequest()
    .withRoute()
    .parseJsonBody()
    .done(async function (e){
        switch (e.route) {
            case 'POST /tip/signup/complete': {
                return {}
            }
            case 'POST /tip/signup/complete': {
                return {}
            }
            case 'POST /tip/invite/confirm': {
                return {}
            }
            case 'POST /tip/invite/confirm': {
                return {}
            }
            default:
                return {}
        }
    })
