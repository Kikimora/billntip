import {S3} from "@aws-sdk/client-s3";
import {configure, EMF, Tracer, TracingOptions} from "@app/diagnostics";
import {repeat, retry} from "@app/util";

export const MetricsNS = "Bill&Tip"

const metrics = EMF.namespace(MetricsNS)
    .dimensions("functionName", "functionVersion")
    .startReporter()

interface BillntipConfig {
    tracing: TracingOptions
}

const tracer = new Tracer("config")
const s3 = new S3()

const loadConfig = async function () {
    try {
        const configResponse = await s3.getObject({Bucket: "CONFIG_BUCKET", Key: "CONFIG_KEY"})
        const configJson = await configResponse.Body?.transformToString()
        let config = JSON.parse(configJson ?? "") as BillntipConfig
        configure(config.tracing)
        return {config, metrics}
    } catch (e: any) {
        tracer.error(e)
        throw e
    }
};

export const AppInit = retry(loadConfig, {delay: 100, maxIterations: 3})

// noinspection JSIgnoredPromiseFromCall
repeat(loadConfig, {delay: 300 * 1000})

