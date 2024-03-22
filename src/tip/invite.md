# Invite a Recipient Use Case

Invite recipient use case has two sub-use cases


The use case does two things:

1. Invite user to join tip.billntip.com.
2. Invite user to join a business registered at bill.billntip.com

## Invite user to join tip.billntip.com

The use case starts when admin or Business initiate invite procedure providing user email. 
1. Admin or Business initiate invite procedure providing user email.
2. Cognito sends invite email with temporary password to the user email.
3. User goes to Cognito hosted UI and provide password.

This is only possible if user
email is not registered with Cognito. 

Admin or Business initiate invite.

```
POST api.billntip.com/invite
Cookie: SID=<business or admin session>
{
    "email": "user email"
}
Response
{
   "id":"invite id",
   "email": "user email",
   "businessId": "business id",
   "expires": "expiration date"
}
```

API perform following steps

1. Create invite
2. Create user if needed:
    - Use `AdminCreateUser` API to create user with temporary one time password
    - Make sure invite record TTL matches temporary password TTL
    - Suppress default invitation email from Cognito
3. Send invite message using SES.

User receives the email and opens
link `tip.billntip.com/invite/{id}?email={email}&pwd={temporary password of a new user}`.

If `pwd` present then:

1. Display a message 'The invite is for a different email, would you like to logout and create an new user to accept
   this invite?' Continue if answer is 'Yes'.
2. Logout

```
POST api.billntip.com/auth/logout 
```

3. Login in cognito and set new password using `email` and `pwd` from the invite link.

Initiate [login](https://docs.aws.amazon.com/cognito/latest/developerguide/how-to-create-user-accounts.html#authentication-flow-for-create-user)

```js
InitiateAuth(Email, USER_SRP_AUTH)
//Amazon Cognito returns the PASSWORD_VERIFIER challenge with Salt & Secret block.
RespondToAuthChallenge(Username, SRP_VARIABLES, PASSWORD_VERIFIER)
//Amazon Cognito returns the NEW_PASSWORD_REQUIRED challenge. 
RespondToAuthChallenge(Username, NEW_PASSWORD, USER_ATTRIBUTES)
//The user is signed in and tokens are issued.
```

4. Start session to get session cookie

```
POST api.billntip.com/auth/start_session
Authorization: Bearer <ACCESS TOKEN>

Set-Cookie: SID=<recipient cookie> 
```

Not we have a session and can get invite details, this only works if session email matches invite email.

```
GET api.billntip.com/invite/{id}
Cookie: SID=<recipient cookie>
{   
   "email": 'user email',
   "business": "business id", ???
   "accepted": false,
   "ttl": 'time to live'
}
```

2. Get session

```
GET api.billntip.com/auth/tokens
```

3. If session email and invite email match and user is in the `recipients` group display 'do you want to accept invite'
   screen and then

```
PUT api.billntip.com/invite/{id}
{ "accepted": true }
```

Alternative Step #1: If invite accepted - display error message. Note - `PUT api.billntip.com/invite/{id}` would return
an error if you try it.

Alternative Step #2: Session does not
exists - [login](https://docs.aws.amazon.com/cognito/latest/developerguide/how-to-create-user-accounts.html#authentication-flow-for-create-user)
using email from invite and code as password

```
1. InitiateAuth(Email, USER_SRP_AUTH).
2. Amazon Cognito returns the PASSWORD_VERIFIER challenge with Salt & Secret block.
3. RespondToAuthChallenge(Username, <SRP variables>, PASSWORD_VERIFIER).
4. Amazon Cognito returns the NEW_PASSWORD_REQUIRED challenge.
5. RespondToAuthChallenge(Username, <New password>, <User attributes>).
6. The user is signed in and tokens are issued.
7. POST api.billntip.com/auth/start_session
Authorization: Bearer <Access token>

Set-Cookie: SID=<Session>
```

Alternative Step #3: Session email and user email does not match - logout user and continue with Alternative Step #2
above.

```
ANY api.billntip.com/auth/logout
```

Alternative Step #3: User is not in the `recipients` group - display registration form. Continue from step #2 after
successfully registration.

## TODO

Invite resource:

```json
{
  "id": "invite id",
  "email": "user email",
  "accepted": false,
  "ttl": "time to live"
}
```

Create invite

```
POST api.billntip.com/invite
Cookie: SID=<business or admin session>
{
    "email": "user email"
}
```

Accept invite.

```
POST api.billntip.com/invite/{id}
Cookie: SID=<recipient session>
{
    "accepted": true
}
Response
{
  "id": "invite id",  
  "email": "user email",
  "accepted": true,
  "ttl": "time to live"
}
OR
{ error: "You email does not match invite email." }
```

Delete invite

```
DELETE api.billntip.com/invite/{id}
```