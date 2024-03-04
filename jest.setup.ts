import * as dotenv from 'dotenv';
import {Console} from 'node:console';

const e = dotenv.config()
if (e.error != null) throw e.error

global.console = new Console({
    stdout: process.stdout,
    stderr: process.stderr,
    inspectOptions: {
        depth: 5
    }
});