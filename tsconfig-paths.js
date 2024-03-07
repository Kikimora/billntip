// this is needed until https://github.com/pulumi/pulumi/issues/3061 is resolved
const { loadConfig, register } = require('tsconfig-paths');
const tsConfig = loadConfig(__dirname + "/tsconfig.json");

console.debug("Loading tsconfig-paths")

if (tsConfig.resultType === 'success') {
    register({
        baseUrl: tsConfig.absoluteBaseUrl,
        paths: tsConfig.paths,
    });
} else {
    console.log("Cannot load tsconfig", tsConfig)
}