/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    testEnvironment: 'node',
    setupFiles: ['./jest.setup.ts'],
    setupFilesAfterEnv: ["./jest.extended.ts"],
    extensionsToTreatAsEsm: ['.ts'],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            useESM: true,
            diagnostics: true
        }]
    },
};