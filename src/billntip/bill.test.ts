import {CognitoIdentityProvider} from "@aws-sdk/client-cognito-identity-provider";


const cognito = new CognitoIdentityProvider()


it("???", () => {

    var inviterEmail = "inviterEmail"

    console.log(errorContext())

    var inviterRole = "inviterRole"

    function errorContext() {
        return {
            name: 'invite',
            value: {
                inviterEmail,
                inviterRole,
            }
        }
    }
})

it("Fails when user exists", async ()=>{
    try {
        await cognito.adminCreateUser({
            UserPoolId: "eu-south-1_xCtFj6q8X",
            Username: "andrey.verbin+bill5@gmail.com",
        })
    } catch (e:any) {
        console.log(e.toString())
    }
})