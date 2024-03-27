# Adventures with ESM

History of modules can be
found [here](https://8thlight.com/insights/a-history-of-javascript-modules-and-bundling-for-the-post-es6-developer). Use
it as a reference to enhance and extend the article.

ESM modules are JS modules that support syntax like `import x from y`. For a long time JS runtimes (browsers, node.js,
deno, etc.) didn't support it natively and required transpiler that would covert `import x from y`
into something like `const x = require("y")`. Two most popular transpiler performing this function are `babel`
and `TypeScript`. Starting form 2017 ESM support have been gradually coming to browser, in 2021 it landed in Node.js.
But even today using ESM is challenging because of variety of issues in JS ecosystem.

## A bit of history

To understand situation we need to start from the very beginning - the ancient times when first version of node.js
arrived with a built-in `require` function. Because JS didn't have native module system by the time node.js arrived
frontenders created multiple competing toolchains to bundle JS files together and provide module abstraction. For
example this is how AMD (Asynchronous Module Definition) module look like

```js
define("alpha", ["require", "exports", "beta"], function (require, exports, beta) {
    exports.verb = function () {
        return beta.verb();
        //Or:
        return require("beta").verb();
    }
});
```

This is `alpha` module that depends on `require`, `exports` and `beta` objects. `require` and `exports` are built-in
while `beta` is another module. `alpha` module provides `verb` function to other modules. Node.js took this idea but
simplified it by providing a globally available `require` function. In Node.js `alpha` module would look like in Node.js

```js
const beta = require("beta")
exports.verb = function () {
    return beta.verb();
    //Or:
    return require("beta").verb();
}
```

Node.JS ecosystem exploded and produced tons of useful code in Node.JS compatible modules. Frontend developers
increasingly started using node modules format instead of AMD. Transpilers accepted code with `import` such as

```js
import {verb as betaVerb} from "beta"

export function verb() {
    return betaVerb()
}
```

and generated something like

```js
const modules = {
    "beta": ""/* module code */,
}

function require(path) {
    return modules[path]
}

(function (require, exports) {
    const {beta: betaVerb} = require("beta")
    exports.verb = function () {
        return betaVerb()
    }
})(require, {})
```

## EMS vs CommonJS

In 2015 JS got `import` keyword, browsers started implementing it in 2017. But toolchains mostly ignored it for three
reasons: a) many was happy with `require`, b) transpilers such as TypeScript and babel accepted code with`import` and
converted it into `require` and c) node.js was really slow implementing `import` (it got it done in 2021).

This new `import` keyword went beyond what a transpiler can do, it supported asynchronous module loading (which we have
had in AMD times :)

```ts
const x = await import("y")
console.log(x.someFunction())
```

No transpiler can convert this into a CommonJS module. This is because asynchronous module loading require support from
runtime itself, transpiler alone cannot solve this problem.

## TypeScript

TypeScript is a popular language compiling into JS. It support `import` syntax but produce CommonJS modules by default.
There are two ways to run a TypeScript program

1. Use a compiler like `tsc` or `esbuild` to produce JS code bundle. This is usually happens in CI/CD before code
   uploaded onto a remote server or into a serverless function.
2. Using a preprocessor such as `ts-node` (based on `tsc`) or `tsx` (based on `esbuild`) to convert TypeScript into JS
   on the fly. This happens almost every time you to run a TypeScript program:
    1. Running scripts with `tsx` or `ts-node`
    2. Running IaaC like `pulumi up` or `cdk deploy`
    3. Running tests with `mocha`, `jest` or `vitest`

What happens under the hood in the in second case is this. v16 `node` got `--loaders` flag which accept a module
that would be called to convert input program into JS. Another way to tell node how to handle TypeScript is
using `--import` flag.

Another [issue](https://github.com/aws/aws-cdk/issues/21329) with CDK. 

## State of the art

To get ESM working with TypeScript you need following:

1. Configure TypeScript to emit ESM modules. This is done using `compilerOptions` in `tsconfig.json`.
2. Tell NodeJS to use ESM module loader by setting `"type":"module"` in package.json.
3. Make sure your tools properly configure loaders they use. And this is where most problems happens.

Here is a list of problems I had:

1. `Jest` uses custom loader `ts-jest` which won't load ESM modules no matter how hard I try.
2. Mocha works with `ts-node` and `tsx`.
    * `ts-node` in ESM mode does not report module load time errors, it returns `ERROR: null`. This dramatically
      complicates debug.
    * `tsx` report errors but messes up source code lines, errors point to wrong location in a file.
3. `vitest` is a champ, it just works. Unfortunately with `vitest` my IDE (`WebStorm`) won't report module load problem
   and just tell me 'no tests found'. I had to run `vitest` from command line to find out root cause.
4. pulumi uses ancient `ts-node` which does not support ESM at all.

## Is it worth it?

Definitely no! Ecosystem clearly not ready to ESM, you hit cryptic issues everywhere and have to have deep understanding
of so many tools to even start digging into them. For all this you get ability to asynchronously load modules and await
at the top level. Async module load is mostly useless on server side. Top level await is kind of nice, it advertised as
a way to load AWS Lambda Function prerequisites in init stage which can reduce latency and runtime. But in reality this
won't work most of the time. Suppose you want to load a Secret Manager Secret before you Lambda function handler.

```ts
const secret = await getSecret()

export async function handler(event) {
    return {
        statusCode: 200,
        body: "OK!"
    }
}
```

This code look nice until you consider what happens when secret changes. Lambda execution environment can be cached for
hours if not days, all that time it can hold stale secret. You would want to reload the secret once in a while to avoid
this, meaning top level await gives you a very marginal benefit in terms of runtime cost. My advice is use something
like this and forget about ESM for the next 5 years.

```ts
import {LRUCache} from "lru-cache";

const getSecrets = _.memoize(async function () {
   /*load your secrets here*/
})
getSecrets.cache = new LRUCache({ttl: 300000})

export async function handler(event) {
    const secret = await getSecret()
    return {
        statusCode: 200,
        body: "OK!"
    }
}
```

# But what if I want top-level await?

Workaround above for top-level await is nice, but it has two downsides.

1. It does not play well with provisioned concurrency. Lambda Init phase finish as soon as top level promises created.
   Provisioned concurrency freeze runtime right after Init phase, meaning NodeJS runtime is frozen right after starting
   async init. First request will trigger function and async init continuation negating some of the provisioned
   concurrency benefit.
2. Lambda function cannot handle runtime termination events (SIGTERM and SIGINT) unless they have an internal extension.
   They can be registered only during Init phase. Because Init finishes as soon as promise created internal extension
   registration fails with "Extension registration closed already" error.

Top level await is a solution to both problems, however it is not easy to get it working because of the many issues with
ESM described above.

1. Compile all TypeScript into JS, bundle it as-is into a zip file (including dependencies) and upload. Downsides is
   complex build process. node_modules likely be too large for Lambda and would require special handling using Lambda
   Layers. Test code likely use modules with top-level-await which is problematic.
2. Add ESM index.mjs as entry point like this
```js
import * as fn from "./function.js" 
export * from "./function.js"
//Use top level await feature to register extension and run async level init in Init phase.
await Promise.all([
   fn.__init !== undefined ? fn.__init : Promise.resolved(),
   registerInternalExtension()    
])
```