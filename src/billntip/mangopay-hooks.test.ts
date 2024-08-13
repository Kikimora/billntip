import {makeTestHandler, prepare} from "@app/test";
import {SES} from "@aws-sdk/client-ses";
import {TemplateRepo} from "@src/templates";
import {MangopayAPI} from "./mangopay-user";
import {KYCProcess} from "./schemas";
import {__init, handler} from "./mangopay-hooks";
import _ from "lodash";

const testHandler = makeTestHandler(handler, {
    routeKey: "GET /tip/mangopay/callback",
    query: {
        "Date": `${Date.now()}`
    }
})

const fixture = prepare('Once', {
    async before() {
        const {users} = await __init()

        const user = await users.create("mangopay hooks test user", "trusted", [
            {name: "email", value: "mangopay_hooks_test_user@example.com", verified: true},
            {name: "user_attr", value: "attribute value"}
        ])

        const fetchKYCDoc = jest.spyOn(MangopayAPI.prototype, 'fetchKYCDocument')

        const fetchTemplate = jest.spyOn(TemplateRepo.prototype, 'fetchTemplate')
        const templateBody = jest.fn().mockReturnValue("template HTML")
        fetchTemplate.mockReturnValue(Promise.resolve(templateBody as any as _.TemplateExecutor))

        const sendEmail = jest.spyOn(SES.prototype, 'sendEmail')

        return {user, fetchTemplate, sendEmail, templateBody, fetchKYCDoc}
    },
    async after({user}) {
        await user.delete(true)
    }
})

describe("MangoPay hooks", () => {

    describe("KYC hooks", () => {

        it.each([
            {
                eventType: "KYC_VALIDATION_ASKED",
                status: "VALIDATION_ASKED" as KYCProcess['status'],
                template: "kyc-started-email.html",
                title: "Your Bill&Tip account is in review."
            },{
                eventType: "KYC_SUCCEEDED",
                status: "VALIDATED" as KYCProcess['status'],
                template: "kyc-succeeded-email.html",
                title: "Account verification successfully completed."
            }, {
                eventType: "KYC_OUTDATED",
                status: "OUT_OF_DATE" as KYCProcess['status'],
                template: "kyc-outdated-email.html",
                title: "Additional account verification required."
            }, {
                eventType: "KYC_FAILED",
                status: "REFUSED" as KYCProcess['status'],
                template: "kyc-failed-email.html",
                title: "Account verification failed."
            }
        ])("notifies user on $eventType", async ({eventType, status, template, title}) => {
            const {fetchKYCDoc, sendEmail, fetchTemplate, templateBody} = fixture()
            //arrange
            const doc: KYCProcess = {
                created_at: Date.now(),
                type: 'identity',
                status: status,
                process_id: 'kyc_doc_id',
                processed_at: Date.now(),
                tag: "mangopay hooks test user"
            };
            fetchKYCDoc.mockReturnValue(Promise.resolve(doc))
            sendEmail.mockImplementation(() => Promise.resolve({
                MessageId: "message id"
            }))
            //act
            await testHandler({
                query: {
                    RessourceId: "kyc_doc_id",
                    EventType: eventType
                }
            })
            //assert
            expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
                Source: "no-reply@billntip.com",
                Destination: {ToAddresses: ["mangopay_hooks_test_user@example.com"]},
                Message: {
                    Body: {
                        Html: {
                            Charset: "utf8",
                            Data: expect.toBeString()
                        }
                    },
                    Subject: {
                        Charset: "utf-8",
                        Data: title
                    }
                }
            }))
            expect(fetchTemplate).toHaveBeenCalledWith(template)
            expect(templateBody).toHaveBeenCalledWith({
                attributes: [{name: "user_attr", value: "attribute value"}],
                metadata: {env: "dev", ...doc},
                username: "mangopay hooks test user"
            })
        })

        it.each([
            {eventType: "KYC_VALIDATION_ASKED"},
            {eventType: "KYC_SUCCEEDED"},
            {eventType: "KYC_OUTDATED"},
            {eventType: "KYC_FAILED"}
        ])("$eventType hook works even if no template", async ({eventType}) => {
            const {fetchKYCDoc} = fixture()
            //arrange
            fetchKYCDoc.mockReturnValue(Promise.reject(new Error("Cannot find template")))
            //act
            const response = await testHandler({
                query: {
                    RessourceId: "kyc_doc_id",
                    EventType: eventType
                }
            })
            //arrange
            expect(response.statusCode).toBe(200)
        })
    })

})