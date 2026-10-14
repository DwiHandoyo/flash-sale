# 10. Infrastructure

> **In short:** locally, everything runs with one Docker Compose command. Production on AWS is described, but not deployed, in [Cloud deployment](12-cloud-deployment.md). Heavy traffic stops at Redis, so only the API servers and Redis need to be fast. RabbitMQ and PostgreSQL see at most one message or one row per unit of stock.

## Where the load goes

```
10,000+ requests ──► nginx ──► API (3 replicas)
                                 │  every purchase attempt
                                 ▼
                               Redis        ← the heaviest load
                                 │  winners only (≤ stock, e.g. 100)
                                 ▼
                   RabbitMQ ──► Worker ──► PostgreSQL
                   (≤ stock messages)       (≤ stock rows)
```

We invest in speed where the load is (API and Redis) and in reliability where the data is (RabbitMQ and PostgreSQL).

## Local: Docker Compose

`docker compose up --build` starts the whole system.

| Service     | Image                               | Copies    | Key settings                                                                                                                                          | Host port               |
| ----------- | ----------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `web`       | nginx 1.30 + the React build        | 1         | Load balances over the API servers; retries a failed request on another server                                                                        | 8080                    |
| `api`       | `api` app on Node 24 LTS            | 3         | Stateless, health check on `/health/ready`                                                                                                            | —                       |
| `worker`    | `worker` app on Node 24 LTS         | 2         | RabbitMQ consumer with manual acks                                                                                                                    | —                       |
| `bootstrap` | `jobs` app on Node 24 LTS           | Runs once | Creates tables, the sale and the RabbitMQ queues, then reconciles. The other jobs (`reconcile`, `recover`, `reset`) run from the same image on demand | —                       |
| `scheduler` | `jobs` app on Node 24 LTS           | 1         | Local stand-in for EventBridge Scheduler: waits until `endsAt`, then runs reconciliation twice (at `endsAt` and 5 minutes later)                      | —                       |
| `redis`     | Redis 8.2                           | 1         | `appendfsync always`; `maxmemory-policy noeviction`, so sale data is never evicted                                                                    | 16379                   |
| `rabbitmq`  | RabbitMQ 4.x with management plugin | 1         | Quorum queue `orders` with a dead-letter queue                                                                                                        | 5672, 15672 (dashboard) |
| `postgres`  | PostgreSQL 17                       | 1         | Main database plus a separate database for tests                                                                                                      | 15432                   |

- **Host ports for Redis and PostgreSQL are not the defaults** (6379, 5432), so they do not clash with copies already installed on the reviewer's machine.
- **All data lives in Docker volumes,** so it survives container restarts.
- **The RabbitMQ topology is created in code** by the bootstrap job, not set up by hand.
- **Each app has its own image,** built from one [`Dockerfile`](../Dockerfile) with a target per app, and run as a non-root user.
- **Backend images carry no `node_modules`.** esbuild bundles each backend app, its dependencies included, into one file ([`scripts/bundle.js`](../scripts/bundle.js)). The image holds Node.js and that file. The worker's Lambda package in production is the same kind of bundle.
- **The other jobs run on demand** from the same image, for example `docker compose run --rm jobs reset --stock 100 --starts-in 10` or `docker compose run --rm jobs recover`.

## Production

The AWS setup is described in [Cloud deployment](12-cloud-deployment.md). That document covers the architecture, the network and security rules, scaling, what happens when a zone fails, the deployment pipeline, and the infrastructure-as-code design in [`infra/aws/`](../infra/aws). The table below only compares the two setups.

## Local vs production at a glance

| Aspect                     | Local / development                                                                                                                                 | Production (AWS, described)                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Purpose                    | Run and test everything on one laptop                                                                                                               | Serve real users reliably                                          |
| How it runs                | Docker Compose, one command                                                                                                                         | Managed services spread over at least two availability zones       |
| Survives a machine failure | No, because everything is on one machine                                                                                                            | Yes, because every stateful part is replicated                     |
| API servers                | 3 fixed replicas                                                                                                                                    | ECS, scaled out 10 minutes before each sale and back in afterwards |
| Workers                    | 2 long-running containers                                                                                                                           | Lambda, invoked only when orders arrive, with limited concurrency  |
| Redis                      | One node, with every write saved to disk                                                                                                            | MemoryDB across zones, or ElastiCache with a replica and failover  |
| RabbitMQ                   | One node                                                                                                                                            | 3-node cluster (Amazon MQ)                                         |
| PostgreSQL                 | One container, plus a separate test database                                                                                                        | RDS Multi-AZ with automated backups                                |
| Scheduled jobs             | Bootstrap runs at start-up. A small `scheduler` service stands in for EventBridge Scheduler and runs reconciliation at `endsAt` and 5 minutes later | EventBridge Scheduler and ECS scheduled scaling                    |
| Recovery                   | `recover` command, run by hand                                                                                                                      | The same job as a one-off ECS task, started by an operator         |
| Configuration and secrets  | Environment variables in Compose                                                                                                                    | Environment variables, with secrets in AWS Secrets Manager         |
| Network                    | One Docker network, with a few ports published to the laptop                                                                                        | Private subnets; only the load balancer and the CDN are public     |
| Logs and monitoring        | Container logs and the RabbitMQ dashboard                                                                                                           | CloudWatch logs, metrics and alarms                                |

The application code is the same in both. Only the wiring around it changes.

## Scheduling

**Opening and closing the sale needs no scheduler.** Every request compares Redis's clock with `startsAt` and `endsAt` (see [Purchase flow](03-purchase-flow.md)). A scheduler is used only for work that must actually be done at a certain time:

| When                         | Job                                                                                                                                                                             | Local                                                 | Production                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| 10 minutes before `startsAt` | Preparation: run the bootstrap job again so Redis matches PostgreSQL. If it fails (e.g. Redis or PostgreSQL unreachable), an alarm goes off while there is still time to fix it | At `docker compose up`, before the API starts         | EventBridge Scheduler, one-time schedule |
| 10 minutes before `startsAt` | Scale out the API servers                                                                                                                                                       | — (fixed number of replicas)                          | ECS scheduled scaling                    |
| At `endsAt`                  | Reconciliation: publish any reservation that has no order record yet                                                                                                            | The `scheduler` service; also the `reconcile` command | EventBridge Scheduler, one-time schedule |
| 5 minutes after `endsAt`     | Second reconciliation run, in case the first one failed                                                                                                                         | The `scheduler` service                               | EventBridge Scheduler, one-time schedule |
| After the sale               | Scale the API servers back in                                                                                                                                                   | —                                                     | ECS scheduled scaling                    |

### EventBridge Scheduler

- **Three kinds of schedule:** `at(...)` runs once at an exact time, `rate(...)` repeats at an interval, `cron(...)` follows a pattern.
- **We use `at(...)`.** When a sale is configured, its schedules are created through the API, at that sale's own `endsAt`. When the sale changes, the schedules are updated.
- **Built-in reliability:** retries, a dead-letter queue for runs that keep failing, and time zones.
- **Precision is one minute.** That is fine for reconciliation, and it is one more reason why the sale window is checked on every request instead of being switched on and off by a scheduler.

```ts
await scheduler.send(
  new CreateScheduleCommand({
    Name: `reconcile-${sale.id}`,
    ScheduleExpression: `at(${toAwsTime(sale.endsAt)})`, // e.g. at(2026-10-20T11:00:00)
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: 'OFF' }, // run at the given time, not within a window
    Target: {
      Arn: reconcileLambdaArn,
      RoleArn: schedulerRoleArn,
      Input: JSON.stringify({ saleId: sale.id }),
      RetryPolicy: { MaximumRetryAttempts: 5 },
      DeadLetterConfig: { Arn: schedulerDlqArn }, // still failing → dead-letter queue → alarm
    },
    ActionAfterCompletion: 'DELETE', // a one-time schedule removes itself
  }),
);
```

### Rules for scheduled jobs

- **Idempotent.** Schedulers deliver at least once, so a job that runs twice must do no harm. Reconciliation already works this way.
- **Retries and an alarm,** including an alarm when a job did not run at all.
- **All times in UTC.**
- **Never the only guard.** Business rules are checked on every request; scheduled jobs only do follow-up work.

## Observability

- **Local:** structured JSON logs from every service, plus the RabbitMQ dashboard (queues, dead letters, consumers).
- **Production alarms in CloudWatch:**
  - the dead-letter queue is not empty,
  - the order queue keeps growing,
  - Redis buyers and PostgreSQL orders do not match,
  - the 5xx rate rises,
  - a scheduled job failed.

## Stress test setup

- **`npm run stress` runs it,** with the load generator as the `stress` service. See [Testing](09-testing.md) for the options and the checks.
- **The load generator runs inside the Docker network,** not from the laptop through Docker's published ports. On macOS, Docker Desktop's port forwarding can become a bottleneck of its own and distort the results.
- **The generator and the system share the same laptop CPU,** so throughput numbers are relative, not a capacity promise. The README states this next to the results.

---

Previous: [9. Testing](09-testing.md) · Next: [11. Code structure](11-code-structure.md)
