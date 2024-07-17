import {specializeUnionError, TaggedUnion} from "./tagged_union";
import {Kind, Type} from "@sinclair/typebox";
import {Value} from "@sinclair/typebox/value";

const IBANBankAccount = Type.Object({
    type: Type.Literal("IBAN"),
    iban: Type.String(),
})
const CABankAccount = Type.Object({
    type: Type.Literal("CA"),
    account_number: Type.String(),
})

const BankAccountDetails = TaggedUnion([
    IBANBankAccount,
    CABankAccount,
], {tag: "type"});


describe("prettifyUnionValidationError", () => {

    it("works", () => {

        const e = specializeUnionError({
            "type": 62,
            "schema": {
                "anyOf": [{
                    "type": "object",
                    "properties": {
                        "type": {
                            "description": "For accounts registered in the United States ",
                            "const": "US",
                            "type": "string"
                        },
                        "account_number": {"description": "The account number of the bank account.", "type": "string"},
                        "aba": {
                            "description": "The American Banking Association (ABA) routing number for US-type bank accounts.",
                            "type": "string"
                        },
                        "deposit_type": {
                            "description": "The deposit type for US-type bank accounts.",
                            "anyOf": [{"const": "CHECKING", "type": "string"}, {"const": "SAVINGS", "type": "string"}]
                        }
                    },
                    "required": ["type", "account_number", "aba"]
                }, {
                    "type": "object",
                    "properties": {
                        "type": {
                            "description": "For accounts registered in countries that use IBAN",
                            "const": "IBAN",
                            "type": "string"
                        },
                        "iban": {
                            "description": "The IBAN (international bank account number) of the bank account.",
                            "type": "string"
                        },
                        "bic": {"description": "The BIC (international identifier of the bank).", "type": "string"}
                    },
                    "required": ["type", "iban"]
                }, {
                    "type": "object",
                    "properties": {
                        "type": {
                            "description": "For accounts registered in Canada",
                            "const": "CA",
                            "type": "string"
                        },
                        "account_number": {"description": "The account number of the bank account.", "type": "string"},
                        "bank_name": {
                            "description": "The name of the Canadian bank for CA-type bank accounts.",
                            "type": "string"
                        },
                        "branch_code": {
                            "description": "The 5-digit number assigned to branches of Canadian financial institutions, for CA-type bank accounts.",
                            "type": "string"
                        },
                        "institution_number": {
                            "description": "The 3-digit number assigned to Canadian financial institutions, for CA-type bank accounts.",
                            "type": "string"
                        }
                    },
                    "required": ["type", "account_number", "bank_name", "branch_code", "institution_number"]
                }, {
                    "type": "object",
                    "properties": {
                        "type": {
                            "description": "For accounts registered in the United Kingdom",
                            "const": "GB",
                            "type": "string"
                        },
                        "account_number": {"description": "The account number of the bank account.", "type": "string"},
                        "sort_code": {
                            "description": "The 6-digit sort code, assigned to UK financial institutions, for GB-type bank accounts.",
                            "type": "string"
                        }
                    },
                    "required": ["type", "account_number", "sort_code"]
                }, {
                    "type": "object",
                    "properties": {
                        "type": {
                            "description": "For accounts registered in countries that do not use IBAN (and are not US, CA, GB).",
                            "const": "OTHER",
                            "type": "string"
                        },
                        "account_number": {"description": "The account number of the bank account.", "type": "string"},
                        "bic": {"description": "The BIC (international identifier of the bank).", "type": "string"},
                        "country": {
                            "maxLength": 2,
                            "description": "Bank country code in the ISO 3166-1 alpha-2 format.",
                            "type": "string"
                        }
                    },
                    "required": ["type", "account_number", "bic", "country"]
                }]
            },
            "path": "/details",
            "value": {"type": "IBAN", "ibana": "PT50003502080001399113075"},
            "message": "Expected union value"
        })

        console.log(JSON.stringify(e, null, 2))
    })

    it("skips normal errors", () => {
        const error = new Error()
        expect(specializeUnionError(error)).toBe(error)
    })

    it("validates faulty value against union member", () => {
        let error
        try {
            Value.Decode(BankAccountDetails, {"type": "IBAN", "iban": 1})
        } catch (e: any) {
            error = specializeUnionError(e.error)
        }
        expect(error).toEqual({
            "message": "Expected string",
            "path": "/iban",
            "schema": {
                "type": "string",
                [Kind]: "String",
            },
            "type": 54,
            "value": 1,
        })
    })

    it("detects invalid union discriminator", () => {
        let error
        try {
            Value.Decode(BankAccountDetails, {"type": "Invalid discriminator value", "iban": "some iban"})
        } catch (e: any) {
            error = specializeUnionError(e.error)
        }
        expect(error).toEqual({
            "message": "Expected union value",
            "path": "/type",
            "schema": {
                "anyOf": [
                    {
                        "const": "IBAN",
                        "type": "string",
                        [Kind]: "Literal",
                    },
                    {
                        "const": "CA",
                        "type": "string",
                        [Kind]: "Literal",
                    },
                ],
                [Kind]: "Union",
            },
            "type": 62,
            "value": "Invalid discriminator value",
        })
    })
})