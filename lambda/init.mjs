/*global fetch*/
// noinspection JSFileReferences
import * as app from "./function.js"
// noinspection JSFileReferences
export * from "./function.js"

//Run function init
let init
if (app.__init instanceof Promise) {
    init = app.__init
} else if (typeof app.__init === 'function') {
    init = app.__init()
} else {
    init = Promise.resolve()
}

let extensionId
async function runExtension(baseUrl) {
    //1. Register internal extension
    extensionId = await register(baseUrl)
    //2. Let Runtime know extension exists
    // noinspection JSUnusedLocalSymbols
    const _ = next(baseUrl, extensionId)
}

//Register internal extension to receive SIGTERM and SIGINT
let extension
if (process.env.AWS_LAMBDA_RUNTIME_API !== undefined) {
    // noinspection HttpUrlsUsage
    const baseUrl = `http://${process.env.AWS_LAMBDA_RUNTIME_API}/2020-01-01/extension`;
    extension = runExtension(baseUrl)
} else {
    extension = Promise.resolve();
}
//Wait for all initialization to complete
await Promise.all([init, extension])


async function register(baseUrl) {
    const res = await fetch(`${baseUrl}/register`, {
        method: 'post',
        body: JSON.stringify({'events': []}),
        headers: {
            'Content-Type': 'application/json',
            'Lambda-Extension-Name': 'NodeJS_SIGTERM',
        }
    });
    if (!res.ok) {
        throw new Error(`Internal extension registration failed: ${res.status} ${await res.text()}`)
    }
    return res.headers.get('lambda-extension-identifier');
}

async function next(baseUrl, extensionId) {
    try {
        const res = await fetch(`${baseUrl}/event/next`, {
            method: 'get',
            headers: {
                'Content-Type': 'application/json',
                'Lambda-Extension-Identifier': extensionId,
            }
        });
        return await res.json();
    } catch (e) {
        console.log(e)
    }
}