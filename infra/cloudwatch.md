# CloudWatch

Metric is a combination of name and dimensions. Metric name identifies what being tracked while dimensions identify data
origin produced the record. For example to track memory usage one can setup metric with name 'Memory' and dimension '
EC2'.
With this setup each EC2 instance reporting memory would create one metric from CloudWatch standpoint.

# Billing & Cost

CloudWatch has IncomingBytes metric for a log group which reports uncompressed bytes. Looks like this is the metric
being
used to charge for data ingestion. 10 bytes of payload increase this metric by 36 bytes. 100 bytes of payload increase
it by 136 bytes.

//36 bytes logged in IncomingBytes, 26 bytes overhead
AWS_PAGER="" aws --profile billntip-dev --region eu-south-1 logs put-log-events --log-group-name=/aws/lambda/test
--log-stream-name='test' --log-events="timestamp=$(date +%s%3N),message=0123456789
//126 bytes logged in IncomingBytes, 26 bytes overhead
AWS_PAGER="" aws --profile billntip-dev --region eu-south-1 logs put-log-events --log-group-name=/aws/lambda/test
--log-stream-name='test' --log-events="timestamp=$(date +%s%3N)
,message=0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789

Compressing HTTP request payload does not improve the metric, it still reports 126 bytes per 100 bytes of payload.

# Ideal monitoring scenario from a cost standpoint

User set a cost threshold and system adjust sampling and batching intervals to hit the target.

# EMF vs PutMetricData

With EMF you pay for CloudWatch log ingest which is 0.50 USD per 1 GB (crazy, I know). EMF documents have overhead,
they are almost never less than 512 bytes even of they report single number. Alternative is PutMetricData API which
is billed at 0.01 USD per 1000 requests and has per-call limits:

1. 1000 different metrics.
2. 150 values per metric.
3. Up to 1 MB compressed data.
4. All metrics has to be be in the same namespace.

This strongly suggests PutMetricData API were designed with batching in mind. A centralised batching services receives
metrics from multiple sources. This naturally produce a lot of metrics per unit of time (limit is 1000 metrics per
call).
Because there are many reporters each individual metric contains relatively small amount of data. Which again plays well
with limit of 150 values per metric. The batching service should receive metrics for a unit of time and then send one
large PutMetricData call.

Imagine there is a Lambda Extension working as a batching service. Assume lambda publish 5 metrics each time it runs.
For 1 million calls best case would be batching 5 metrics with 150 values each. This translates into 6666 calls to
PutMetricData API and $0.0666. If we require metrics update once a minute then the extension will call API 44640
times per month and cost $0.44. If there are more than 150 events per minute then extension have to either sample or
call PutMetricData more frequently increasing cost. Sampling can keep cost close to 0.44 per lambda function even for
heavy loaded application. A standalone batching service can deliver same cost for N lambda functions until it hit the
limit of 1000 metrics per call.

EMF has its limits too:

1. 100 Metrics (all has to have same dimensions).
2. 100 metric values.
3. As with PutMetricData all metrics has to be under the same namespace.

Lets compare PutMetricData with EMF. First Lambda receiving 1 000 000 events and producing same number of EMF documents,
each reporting 5 metrics translates into ~1 GB of ingestion which is 0.5 USD. This is a win compared to unbatched
PutMetricData ($10), a huge loss compared to fully batched ($0.0666) and close to a situation when lambda reports every
minute ($0.44). Now imagine there is an extension that receives 5 metrics from each lambda invocation, batches them and
sends as soon as it reaches 100 values or 1 minute passes. EMF document with 100 values for 5 metrics can be as large
as 10Kb, sending 44640 such documents per month would cost $0.22. The cost is smaller than PutMetricData with batching
done in an extensions. If we imagine a standalone service that batches calls from multiple services then using EMF is
less beneficial because price directly proportional to traffic rather than to the number of API calls. If each service
publishes 5 metrics then PutMetricData can batch up-to 200 sources without cost increase from $0.44, EMF would
pay 200*0.22 ~ $44 USD in the same situation. 

Conclusions:

1. Use PutMetricData with batching if you build a shared metrics collector.
2. Use EMF with batching otherwise. Use Lambda External Extensions or Internal extensions to receive termination signals
   and send last batch.
3. Don't report metrics without batching as it will blow your CloudWatch bill.

# Batching without extensions

Lambda runtime sends SIGTERM signal when it is about to shutdown the runtime. If runtime batched a small batch of data
this is its chance to send it.
https://stackoverflow.com/questions/76150435/how-can-i-handle-a-process-exit-in-an-aws-lambda-function-in-order-to-flush-some
Shutdown phase is capped at 2 seconds. If the runtime or any extension does not respond, Lambda terminates it via a
signal SIGKILL. The maximum duration of the Shutdown phase depends on the configuration of registered extensions:
0 ms – A function with no registered extensions
500 ms – A function with a registered internal extension
2,000 ms – A function with one or more registered external extensions

https://github.com/aws/aws-lambda-go/issues/318#issuecomment-1019318919
https://github.com/aws-samples/graceful-shutdown-with-aws-lambda/blob/main/nodejs-demo/hello-world/app.js

This is how SIGTERM can be enabled from inside running Lambda function
https://github.com/bmoffatt/aws-lambda-go/blob/752114b59f86409c6aa12fe64e340ab78e09084b/lambda/sigterm.go#L14