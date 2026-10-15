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

**Run it** with `npm run stress` (Docker and `npm ci` are all it needs). It builds and starts the whole system, resets the sale, runs the load from a container inside the Docker network, then checks the data stores. It exits with code 1 when a check fails.

| Option           | Default                              | Meaning                                                                                        |
| ---------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `--users`        | 10,000                               | Users who press "Buy"                                                                          |
| `--stock`        | 100 (with `--chaos`: half the users) | Units on sale                                                                                  |
| `--connections`  | 500                                  | Users waiting for an answer at the same moment                                                 |
| `--double-click` | 0.1                                  | Share of users who click twice                                                                 |
| `--pollers`      | 0                                    | Extra users who poll the sale status every 2 s during the sale, to measure the CDN cache (D16) |
| `--chaos`        | none                                 | A fault to inject during the run (see Chaos runs)                                              |
| `--chaos-after`  | 1000                                 | When to inject it, in milliseconds after the opening                                           |

Example: `npm run stress -- --users 20000 --stock 500`.

**Scenario.** All users press "Buy" the moment the sale opens, and some of them click twice. Their requests go through nginx to three API servers. A user who gets a 5xx answer or no answer tries again up to three times, as a person would.

**Verification.** Afterwards the test waits until the workers have saved every order. If a reservation still has no order, because its publish was never confirmed, the test runs reconciliation, as the scheduler does at `endsAt`, and waits again. Then it checks Redis, PostgreSQL and RabbitMQ directly instead of trusting the API's own answers:

| Check                                                 | What it means                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| Exactly `min(stock, users)` units sold                | No overselling and no underselling                              |
| At most one order per user                            | "One per user" held, and no user was given two different orders |
| `remainingStock` + buyers = `totalStock`              | No stock was created or lost                                    |
| Every "you got it" answer has its order in PostgreSQL | A confirmed purchase was never lost                             |
| Redis buyers and PostgreSQL orders match              | The two stores agree                                            |
| `sold_count` matches the order rows                   | The database guard counted correctly                            |
| Every order falls inside the sale window              | The window was enforced                                         |
| Order queue drained, dead-letter queue empty          | No order is stuck or rejected                                   |

**Report.** The number of answers per outcome, throughput, latency (p50, p95, p99, max), and the answers per second, which shows what a fault did and when.

**`appendfsync always` vs `everysec` (D7).** `REDIS_APPENDFSYNC=everysec npm run stress` restarts Redis with `everysec`; the next plain `npm run stress` switches it back. This measures what `always` costs. It cannot show what `everysec` risks: with both settings, Redis hands each write to the operating system before it replies, so only a crash of the machine itself loses data under `everysec`, and killing a container is not such a crash.

**CDN cache (D16).** `npm run stress -- --pollers 10000` reports how the status polls were answered: from nginx's cache (`HIT`) or by an API server. In one run, 99.7% of 13,415 polls came from the cache and 41 reached the API. The pollers share the laptop's CPU with everything else, so with many pollers the load generator itself slows down: their latency shows queueing in the generator, not the cache.

**Scaled-out workers (D15).** `WORKER_REPLICAS=20 npm run stress -- --stock 10000` runs 20 workers, as when many Lambda instances start at once. They opened 21 connections into PgBouncer, and PostgreSQL never saw more than 10. Every check passed.

## Chaos runs

`npm run stress -- --chaos <fault>` runs the same test with a fault injected one second after the opening. Every check still has to pass.

| `--chaos`       | Fault                                                              | Expected result                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kill-api`      | An API server's process is killed; Docker restarts it              | nginx retries its requests on the other servers. All checks pass                                                                                                    |
| `kill-worker`   | A worker's process is killed while it holds unacknowledged orders  | Its messages are redelivered to the other worker. No duplicates in PostgreSQL                                                                                       |
| `stop-postgres` | PostgreSQL is stopped for 10 s                                     | Sales continue. The workers wait, then catch up                                                                                                                     |
| `restart-redis` | Redis is killed and started again 2 s later                        | Data is intact thanks to the append-only file. Sales continue after brief 503s                                                                                      |
| `wipe-redis`    | Redis loses all data; the `recover` job runs, as an operator would | The sale pauses, rebuilds from PostgreSQL and resumes, with no oversell. Some stock may stay unsold, so the first check becomes "no more units sold than the stock" |

---

Previous: [8. Scenarios](08-scenarios.md) · Next: [10. Infrastructure](10-infrastructure.md)
