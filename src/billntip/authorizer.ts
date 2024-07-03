import { Tracer } from "@app/diagnostics";
import {pipeline} from "@app/lambda";
import {APIGatewayAuthorizerEvent, APIGatewaySimpleAuthorizerWithContextResult} from "aws-lambda";

const tracer = new Tracer("billntip")
//
// export const organisation = pipeline<APIGatewayAuthorizerEvent>()
//     .traceRequest({tracer, tag: "org"})
//     .done(async function (event, context): Promise<AuthResult> {
//         const {tracer} = event
//     })
//
// export const user = pipeline<APIGatewayAuthorizerEvent>()
//     .traceRequest({tracer, tag: "org"})
//     .done(async function (event, context): Promise<APIGatewaySimpleAuthorizerWithContextResult> {
//         const {tracer} = event
//     })

//1. Pass Cookie
//2. MUST user cookie authorizer
//3. How to convert cookie authorizer response into JWT?

//1. Pass vanilla Cognito Id or Access token
//2. Org microservice provides Lambda authorizer which converts JWT claims into Auth context used by files.
//as a side effect, files cannot user vanilla requestContext.authorizer.jwt but has to use requestContext.authorizer.lambda

//1. Pass purpose built token
//2. Use standard JWT authorizer + schema to validate access.

//1. Encode permissions URL into vanilla token
//2. Call this URL to get permissions and their TTL

//Ideal situation: Cookie enters API GW, cookie converted into JWT, then GW calls microservice with the JWT.
//All microservice see is JWT

//1. Pass Cookie - microservice will see Lambda authorizer
//2. Pass JWT - client has to call endpoint to get JWT