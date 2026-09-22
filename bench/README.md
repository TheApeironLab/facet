# Query lifecycle benchmark

Run `npm run benchmark`. It creates a temporary one-row database and checks every
result while measuring an intentionally trivial COUNT query. This isolates process
startup/IPC overhead; it does not measure analytical workload throughput.

It reports SDK cold startup, 30 sequential warm queries, 100 concurrent requests
(with maxWorkers=2/maxQueue=128), 30 requests through one CLI session, and 30
independent CLI invocations. The default queue is smaller (64) and intentionally
rejects excess requests with QUEUE_FULL; that behavior is covered in tests.

Local sample on macOS arm64, Node 22.21.1, @photostructure/sqlite 2.6.0:

| Measurement | Time |
| --- | ---: |
| First SDK query | 96.20 ms |
| 30 warm SDK queries, total | 14.30 ms |
| Warm SDK median | 0.37 ms |
| 100 concurrent SDK queries | 108.39 ms |
| 30 queries in one CLI session, including startup | 264.68 ms |
| 30 independently started CLI invocations | 7593.74 ms |

The pool created 2 processes, with a peak of 2.

These are local observations, not latency guarantees. They were taken as the best
of 5 runs on a machine that was not idle; contention only slows a run down, so the
minimum is the closest available estimate of the floor. Individual runs on a busy
machine were several times slower, and absolute values differ by hardware, Node
version and SQLite driver build. Compare shapes, not absolute numbers: warm pooled
queries are orders of magnitude cheaper than process startup, and a CLI session is
far cheaper than repeated one-shot invocations. Re-measure after changing the pool,
the query worker or the SQLite driver, and report cold and warm timings separately.
CLI cold-start cost remains when each query starts a new process. Pool bounds apply
to each SDK instance, not every process on the machine.
