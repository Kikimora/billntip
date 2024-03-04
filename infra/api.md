# API GW

REST API cost 3.5 USD per million, HTTP API cost 1 USD per million. 
REST API has:
1. Cache, but very limited ways to invalidate it.
2. API Keys with usage plans. Not really good for classic API keys, but can be helpful to avoid DDoS attacks. Each user 
or a bucket of users receive an API Key with associated usage plan to throttle requests if they come over the limit.
3. Response compression

HTTP API:
1. Most frequent cache scenario - user profile and permissions achieved using authorizer cache. Other data can be cached using DynamoDB DAX as needed.
2. Throttling via use of sampling and DynamoDB. Idea is - sample 1% or 0.1% of requests and store count in DynamoDB. Block 
users that go above the limit using authorizer function. Set concurrency limit to authorizer thus limiting maximum amount you'll pay a month if DDoS happens.
3. Compression via https://github.com/jeremydaly/lambda-api?tab=readme-ov-file#compression or https://www.npmjs.com/package/lambda-compression

You don't pay for unauthorized API GW requests! https://stackoverflow.com/questions/49048666/do-you-get-charged-for-requests-that-fail-an-apig-custom-authorizer-unauthorize

Throttling similar to REST API keys can be achieved this way:
1. Public login endpoint issuing session cookie
2. Endpoint exchanging cookie for a short lived JWT token
3. Setup JWT authorizer for all other endpoints.
4. If user abuse an endpoint - don't refresh JWT and disable login.

In effect there are two endpoints running custom Lambda: auth callback issuing cookies and endpoint exchanging cookie 
for a token. Only they can be abused by an attacker, other endpoints protected by API GW. Use WAF to protect these 
endpoints and you are good to go! Unfortunately WAF support for HTTP APIs is currently not supported. Two workarounds
1. Implement two endpoints as REST API and enable WAF on them.
2. Front the API Gateway with Amazon CloudFront and enable WAF on CloudFront.
https://repost.aws/questions/QU0cc8yP29RYyFOB4Vx-uK_Q/protect-http-api-gateway-with-waf
https://wellarchitectedlabs.com/security/300_labs/300_multilayered_api_security_with_cognito_and_waf/3_prevent_requests_from_accessing_api_directly/

This is almost equivalent to REST API scenario:
1. Public login endpoint issuing tokens
2. Client saving tokens in local store (bad security practice)
3. Endpoint exchanging token for an API key with a usage plan. Usage plan protects majority endpoints.
4. If user abuse an endpoint - don't refresh JWT and disable login.
5. Use WAF to protect login and API key issuing endpoints.

