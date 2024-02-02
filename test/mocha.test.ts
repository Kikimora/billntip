import {init as cognitoInit} from "./cognito";

const testCognitoModule = await cognitoInit("aa", "bbb")

describe("Calculator Tests", () => {
    it("should return 5 when 2 is added to 3", async () => {
        await testCognitoModule.loadTestGroup()
    });
});