import {APIGatewayProxyEventV2, APIGatewayProxyResultV2} from "aws-lambda";
import { jwtDecode } from "jwt-decode";

export async function handler(req:APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {

    console.log(req)
    const accessTokenHeader = req.headers['x-accesstoken'] as string;
    const accessToken = accessTokenHeader ? jwtDecode(accessTokenHeader) : "";
    const idTokenHeader = req.headers['x-idtoken'] as string;
    const idToken = idTokenHeader ? jwtDecode(idTokenHeader) : "";
    return {
        statusCode:200,
        body: JSON.stringify({
            "access_token": accessToken,
            "id_token": idToken,
        }, null, 2)
    }
}