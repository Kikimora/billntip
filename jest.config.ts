/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    testEnvironment: 'node',
    testRegex: [
        "test/.*test.ts",
        "src/.*test.ts",
        "diagnostics/.*test.ts",
        "doc/.*test.ts",
        "dynamodb/.*test.ts",
        "lambda/.*test.ts",
    ],
    setupFiles: ['./jest.setup.ts'],
    setupFilesAfterEnv: ["./jest.extended.ts"],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', { diagnostics:true }]
    },
    moduleNameMapper: {
        '^@app/(.*)$': '<rootDir>/$1',
        '^@aws/(.*)$': '<rootDir>/aws/$1',
        '^@src/(.*)$': '<rootDir>/src/$1'
    },
};