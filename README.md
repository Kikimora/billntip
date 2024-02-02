# Getting started

1. Use `pulumi up` to create infrastructure
2. Use `npm run build all` to build and update all lambda functions without touching infrastructure
3. Use `npm run build api.handler authorizer.*` to build some lambda functions

# Architecture

## Actors

Server - waiter, worker, anyone performing service and potentially receiving a tip for it
Business - a business organising servers into teams and managing their operations
Payee - person paying a tip

## Services & Apps

Bill & Tip composed of 4 user-facing services and an API:

1. Cognito with Hosted UI - signup, email and phone verification, self-service
2. Tips app - SPA running on `tip.billntip.com`, servicing Servers and Payees.
    * Payee use cases - most functionality is available without signup
        * View server's page
        * Pay to a server
        * Rate service
        * Save card (requires signup, creates MangoPay payee wallet)
        * Use saved card while paying to a server
        * Manage saved cards
    * Server's use cases
        * Manage profile (photo, details, goals, etc)
        * View rating
        * Manage wallet
            * Verify personal wallet (creates MangoPay Natural Person and Owner wallet)
            * View balances
            * Verify bank account
            * Manage bank accounts
            * Withdraw funds to a bank account
        * Team related use cases
            * Respond to an invite to join a team (e.g. restaurant or cafe)
            * Dissociate with a team
3. Bill app - SPA running on `bill.billntip.com`, servicing business users.
    * Manage teams
        * Team balance
        * Team members
        * Invite servers to a team
        * Distribution rules (?)
    * Manage wallet (similar to Servers Manage wallet use case)
        * Verify business wallet (creates MangoPay Legal Person and Owner wallet)
        * View balance (total across all teams)
        * ??? CAN Business take some portion of tips to itself or has to distribute 100% of them?
4. Admin app - SPA running on `admin.billntip.com`
    * Manage users (we can use cognito for this)
    * Manage businesses
    * Manage teams
    * Manage servers
    * Manage wallets (regardless of their type - personal or business) (Mango pay?)
    * Reports (?)
5. All apps use single API running on `api.billntip.com`.

## Authentication and Onboarding Process

Payees portion of the Tips application does not require any authentication. It keeps user information in a
local storage. Signup is required to save card for future use. Because regulations only require first, last name and
email for payees we avoid separate onboarding step. We take email from signup process, first and last name from CC
details provided by the payee.

Regulations are stricter for servers and businesses because they can withdraw money to their bank accounts (payee
cannot do it). When servers access Tips application they first have to signup in the same way as payee. After they have
read-only access to the application until they provide First and Last name, Email, Date of birth, Nationality, Country
of residence and accept ToS. After receiving this information Tips application add users to Servers group and creates
wallet. This
unlocks all functionality except moving money to a bank account. To unlock this function servers have to verify
themselves by submitting
an [identity proof](https://mangopay.com/docs/concepts/users/verification/requirements-natural).

Business users follow similar pattern - Business app is read-only after signup. To unlock functionality business has to
accept ToS and provide details depending on
its [country](https://mangopay.com/docs/concepts/users/verification/requirements-legal?selection=country-type&cpl=Austria&cpr=Business)
Please consult with the link above to understand requirements.

## Data Management

We use multiple data sources
1. Cognito - users
2. MangoPay - wallets
3. DynamoDB - business entities such as Business and server profiles, teams, invites, etc.

### Cognito

Keep users in 3 groups: Servers, Business, Admin, payees do not belong to a group.

### DynamoDB structure

DynamoDb follows single table design with following PKs and SKs

| PK       | SK          | Notes                                      |
|----------|-------------|--------------------------------------------|
| Business |             |                                            |
| Business | Team        |                                            |
| Business | Team#Server |
| Server   |             |                                            |
| Server   | Team        | GSI projected from {Business, Team#Server} |
| Server   | Invite      |                                            |
| Server   | Rating      |                                            |

