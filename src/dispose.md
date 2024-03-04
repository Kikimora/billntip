# using statement in TS

tl;dr; TS 5.2 added `using` statement, unfortunately it is not usable at the time

First of all to get it work you have to set `"target": "es2022"` in `tsconfig.json`.  `"target": "esnext"` won't work
for some reason! When you do it TypeScript produce right code but then you hit another problem which is
described [here](https://github.com/nodejs/node/issues/50745). Basically NodeJS defines Symbol.dispose only in the main
context. If you use `vm` module to compile programs then Symbol.dispose is not defined inside modules created this way.
Unfortunately `ts-jest` does exactly this - use vm module to create test modules.   

