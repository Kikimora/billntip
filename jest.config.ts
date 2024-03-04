/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    testEnvironment: 'node',
    testRegex: "test/.*test.ts",
    setupFiles: ['./jest.setup.ts'],
    setupFilesAfterEnv: ["./jest.extended.ts"],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {}]
    },
};