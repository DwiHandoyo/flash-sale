# 7. Decisions and trade-offs

> **In short:** the table lists every significant choice. The sections below explain each one in a few lines: what we chose, what else we considered, and what it costs us.

|     | Decision                                                                                | Instead of                                                 | Main reason                                                         |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| D1  | A Redis script decides each purchase atomically                                         | Locking a database row                                     | Fast, with no lock queue under contention                           |
| D2  | RabbitMQ carries orders to PostgreSQL and confirms each one before the user is answered | A queue inside Redis (Redis Streams)                       | Every order has a second safe copy before "you got it"              |
| D3  | PostgreSQL is written in the background                                                 | Writing to it on every request                             | The database cannot become the bottleneck                           |
| D4  | Unconfirmed reservations are completed, never cancelled                                 | Expiring them                                              | Cancelling could sell a unit twice                                  |
| D5  | Buying again returns your original order                                                | Answering with an error                                    | Retries are safe for users and for the load balancer                |
| D6  | Redis's clock decides the sale window                                                   | Each API server's clock                                    | Clock drift cannot open the sale early or keep it open late         |
| D7  | Redis syncs every write to disk before replying                                         | Syncing once per second                                    | A restart needs no recovery; cheap because only winners write       |
| D8  | One repository with a separate app per role (API, worker, jobs, web)                    | One app doing everything, or microservices split by domain | Each app deploys and scales on its own; the rules stay together     |
| D9  | Fastify for the API                                                                     | Express, NestJS                                            | Fast, with built-in validation and little ceremony                  |
| D10 | The app polls the sale status every 2 s                                                 | WebSockets or server-sent events                           | Simple and cacheable                                                |
| D11 | Fail fast when overloaded                                                               | Queueing requests until they time out                      | Latency stays predictable and servers stay healthy                  |
| D12 | The sale opens and closes by the clock, checked on every request                        | A scheduler switching it on and off                        | Exact to the millisecond, with no job that can fail                 |
| D13 | In production, workers run on Lambda and the API on containers scaled before the sale   | Serverless everywhere, or containers everywhere            | Each part runs on what fits its load                                |
| D14 | Production infrastructure as code with the AWS CDK in TypeScript, as a design only      | Terraform, or deploying it                                 | Same language as the project; the assignment asks for no deployment |
| D15 | No login, payment, bot protection or rate limiting                                      | Building them                                              | Out of scope; where they would go is noted                          |

## D1. A Redis script decides each purchase

**Choice.** A short Lua script runs inside Redis. It checks the rules and takes a unit as one step that nothing can interrupt.

**Considered.**

- **A row lock in PostgreSQL** (`UPDATE ... SET left = left - 1 WHERE left > 0`). It is correct, but every request waits for the same row lock, so throughput drops exactly when traffic peaks.
- **A distributed lock** (e.g. Redlock). It needs several round trips per purchase and has tricky failure cases, such as lock expiry and clock drift.
- **Queueing every request and processing them one by one.** It is correct, but users do not get an immediate answer.

**Cost.** Redis becomes critical during the sale. See [Scenarios](08-scenarios.md).

## D2. RabbitMQ carries orders, confirmed before the user is answered

**Choice.** After Redis reserves a unit, the API publishes the order to RabbitMQ as a persistent message on a quorum queue. It answers the user only after the publisher confirm arrives. Workers consume with manual acks.

**Considered: a queue inside Redis (Redis Streams).** The script could reserve and enqueue in one atomic step, with no gap between the two. But the order would live only in Redis until a worker saved it. If Redis lost its disk, or failed over to a lagging replica, during that window, a user who was already told "you got it" would lose their order.

**Why RabbitMQ.**

- Every order has a second safe copy, replicated in a cluster, before the user is told.
- Its acknowledgements are mature:
  - automatic redelivery when a consumer dies, without waiting for a timeout,
  - delivery limits and dead-lettering built in,
  - a dashboard to watch the queues.

**Costs.**

- Reserving (Redis) and publishing (RabbitMQ) are two separate steps, so a crash in between can leave a reservation without a message. D4 closes this gap.
- RabbitMQ is on the purchase path: if it is down, purchases answer 503. We accept this because broker outages are rare when RabbitMQ runs as a cluster or managed service.
- Each purchase waits a few milliseconds for the confirm, and there is one more component to run.
- **Why not Kafka:** Kafka is built for high-volume event streams with many consumers and long retention. A task queue with per-message acknowledgements fits this job better.

## D3. PostgreSQL in the background

**Choice.** Workers save orders into PostgreSQL in batches, a few milliseconds after the purchase.

**Why keep PostgreSQL at all?**

- It is the permanent, queryable record for fulfilment, customer service and reporting.
- It enforces "one per user" a second time, independently of Redis.
- It is what we rebuild Redis from after data loss.

**Cost.** There are two stores to keep consistent. [Consistency and recovery](06-consistency-and-recovery.md) explains how.

## D4. Complete reservations, never cancel them

**Why.** When a confirm does not arrive, we cannot know whether RabbitMQ stored the message. Cancelling the reservation could free a unit that is actually sold. Instead, the order is published again when the user retries, and at the end of the sale. The worker skips duplicates.

## D5. Buying again returns the original order

**Why.** A timed-out request can be retried by the user, the app or nginx without risk. That is why nginx is allowed to retry even `POST` requests on another server.

## D6. One clock: Redis

**Why.** The clocks of different API servers drift apart. The script reads the time from Redis, so the window is exactly the same for every request.

**Exception.** Before the opening, the API answers `sale_not_started` without asking Redis, using its own clock ([Purchase flow](03-purchase-flow.md#shortcut-before-the-sale-opens)). A server whose clock runs behind can therefore delay the opening for its users by its clock error, which is milliseconds with synchronised clocks. It cannot open the sale early.

## D7. Redis syncs every write to disk (`appendfsync always`)

**Cost.** Redis waits for the disk on every write, which is slow for write-heavy applications.

**Why it is affordable here.** Only winners write, so there are at most `stock` writes in the whole sale. Over 99% of requests (sold out, already bought, not started, status) only read and never touch the disk.

**Why it is still worth it with RabbitMQ.** Orders are safe in RabbitMQ either way. But syncing only once per second could lose up to a second of reservations if the machine crashes. A crash of the Redis process alone loses nothing, because Redis hands every write to the operating system before it replies. Redis would then believe those units are still available, and every restart would need the recovery procedure. With `always`, a restart needs nothing.

We measure both settings in the stress test.

## D8. One repository, a separate app per role

**Choice.** A monorepo (npm workspaces) with four apps (`api`, `worker`, `jobs`, `web`) and one small `shared` package. To scale, we add identical copies (replicas) of an app.

**Why separate apps.**

- The worker scales differently, runs on a different runtime in production (Lambda) and needs different dependencies than the API. The folder layout should match what gets deployed.
- Each app only depends on what it uses. The API never touches PostgreSQL, the worker never touches Redis, and the worker's Lambda bundle stays small.
- The order message format lives in `shared`, so the API (sender) and the worker (receiver) cannot disagree on it.

**Why not microservices.** The apps are split by role, not by business domain. The domain is a single product and a single sale. Separate stock and order services would make the reservation and the order hard to keep atomic, and would add network hops and operations work.

**Cost.** Workspace setup and a shared package to maintain. Code moves into `shared` only when a second app needs it.

## D9. Fastify

**Why.**

- It is the fastest of the allowed frameworks.
- It validates requests and serialises responses from JSON schemas.
- `app.inject()` makes HTTP tests fast without opening ports.

NestJS adds structure (modules, dependency injection) that a three-endpoint service does not need.

## D10. Polling for status

**Why.** Each server answers status polls from a 0.5 s in-memory cache. Ten thousand users polling every 2 s therefore cost each server about 2 Redis reads per second, and a CDN could cache the response too.

**Cost.** The stock number on screen can be a couple of seconds old. The purchase itself is always checked live.

## D11. Fail fast when overloaded

**Choice.** The Redis client does not queue commands while it is disconnected. Each server answers `503` when its event loop falls more than 1 s behind.

**Cost.** Under extreme load some users see "busy, please retry" instead of waiting. Everyone else stays fast.

## D12. The clock opens and closes the sale

**Choice.** The sale has no on/off switch. Every purchase compares Redis's clock with `startsAt` and `endsAt`.

**Why not a scheduler.**

- A scheduled job can run late or not at all. EventBridge Scheduler, for example, is precise only to the minute.
- With the clock check, the window is exact and every API server agrees on it.
- Schedulers are used only for follow-up work, such as reconciliation at `endsAt`. See [Infrastructure](10-infrastructure.md#scheduling).

## D13. Lambda for workers, containers for the API (production)

**Choice.** In production, the worker runs as a Lambda function with limited concurrency behind RDS Proxy. The API runs on ECS and is scaled out on a schedule shortly before the sale opens.

**Why.**

- The worker's load is small and bursty: at most `stock` orders, then nothing. Paying per invocation suits it, and cold starts only delay saving the order.
- The API receives thousands of requests in the same second. On Lambda that would mean mass cold starts and a flood of new Redis connections. The sale's timing is known in advance, so containers can be ready before the spike.

**Locally** both run as containers. The worker's logic is a single function, so the same code serves both setups.

## D14. Infrastructure as code, as a design

**Choice.** [`infra/aws/`](../infra/aws) describes the production setup with the AWS CDK in TypeScript: three stacks for network, data and app. It is a design only: not deployed, not tested, and its dependencies are not installed. See [Cloud deployment](12-cloud-deployment.md).

**Why the CDK.**

- It uses the same language as the rest of the project.
- High-level building blocks keep the code short, for example an ECS service behind a load balancer.
- `cdk synth` can check the result without an AWS account.

Terraform would be the choice for a multi-cloud setup.

**Why not deployed.** The assignment says a live cloud environment is not needed. Reviewers run everything locally with Docker Compose.

## D15. Not built

In production:

- The user ID would come from the login session.
- Rate limiting would happen at the edge (nginx `limit_req`, a CDN or WAF).
- Bot detection and a virtual waiting room would protect the sale from scripted traffic.

---

Previous: [6. Consistency and recovery](06-consistency-and-recovery.md) · Next: [8. Scenarios](08-scenarios.md)
