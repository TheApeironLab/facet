# Query lifecycle benchmark

Run `npm run benchmark`. It creates a temporary one-row database and checks every
result while measuring an intentionally trivial COUNT query. This isolates process
startup/IPC overhead; it does not measure analytical workload throughput.

It reports SDK cold startup, 30 sequential warm queries, 100 concurrent requests
(with maxWorkers=2/maxQueue=128), 30 requests through one CLI session, and 30
independent CLI invocations. The default queue is smaller (64) and intentionally
rejects excess requests with QUEUE_FULL; that behavior is covered in tests.

Local sample on macOS arm64, Node 25.9.0:

| Measurement | Time |
| --- | ---: |
| First SDK query | 54.04 ms |
| 30 warm SDK queries, total | 5.10 ms |
| Warm SDK median | 0.13 ms |
| 100 concurrent SDK queries | 50.59 ms |
| 30 queries in one CLI session, including startup | 113.18 ms |
| 30 independently started CLI invocations | 3148.61 ms |

The pool created 2 processes, with a peak of 2. These are local observations, not
latency guarantees. CLI cold-start cost remains when each query starts a new
process. Pool bounds apply to each SDK instance, not every process on the machine.
