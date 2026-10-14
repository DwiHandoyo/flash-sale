# 9. Testing

> **In short:** unit tests check the rules in isolation. Integration tests run them against real Redis, RabbitMQ and PostgreSQL. Stress tests hammer the whole system and then verify directly in the data stores that nothing was oversold or lost. Chaos runs break components on purpose.

## Test levels

| Level         | Runs against                                           | What it proves                                                                                                   |
| ------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Unit (server) | No infrastructure                                      | Business rules, input validation, HTTP status codes, configuration                                               |
| Unit (web)    | A simulated browser                                    | The page shows the right message for every outcome                                                               |
| Integration   | Real Redis, RabbitMQ and PostgreSQL in Docker          | The script under concurrency, publisher confirms, worker redelivery and idempotency, recovery and reconciliation |
| Stress        | The whole stack in Docker                              | Correctness under heavy concurrent load, plus throughput and latency                                             |
| Chaos         | The whole stack, with components killed during the run | Every scenario in [Scenarios](08-scenarios.md) ends safely                                                       |

## Showing why atomicity matters

An integration test runs a naive "read the stock, then decrement it" version under the same concurrent load as the real script. The naive version oversells; the script does not. See [Purchase flow](03-purchase-flow.md).

## Stress test

**Scenario.** Thousands of users (for example 10,000, some of them double-clicking) press "Buy" the moment the sale opens. Their requests go through nginx to three API servers.

**Verification.** Afterwards the test waits for RabbitMQ to drain, then checks Redis and PostgreSQL directly instead of trusting the API's own answers:

| Check                                            | What it means                         |
| ------------------------------------------------ | ------------------------------------- |
| Exactly `min(stock, users)` units sold           | No overselling and no underselling    |
| At most one order per user                       | "One per user" held under concurrency |
| `remainingStock` + buyers = `totalStock`         | No stock was created or lost          |
| Every `201` response has its order in PostgreSQL | "You got it" was never lost           |
| Every order falls inside the sale window         | The window was enforced               |

**Report.** Throughput (requests per second), latency (p50, p95, p99) and error counts. The test runs twice, with Redis on `appendfsync always` and on `everysec`, to measure what D7 costs.

## Chaos runs

| Fault injected during the stress test | Expected result                                           |
| ------------------------------------- | --------------------------------------------------------- |
| Kill one API server                   | Every check passes. A few requests fail and are retried   |
| Kill a worker before it acknowledges  | Its messages are redelivered. No duplicates in PostgreSQL |
| Stop PostgreSQL for 10 s              | Sales continue. PostgreSQL catches up afterwards          |
| Restart Redis                         | Data is intact. Sales continue after a brief 503          |
| Wipe Redis, then run the recovery job | The sale pauses, rebuilds and resumes, with no oversell   |

---

Previous: [8. Scenarios](08-scenarios.md) · Next: [10. Infrastructure](10-infrastructure.md)
