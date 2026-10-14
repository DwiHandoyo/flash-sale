# 5. API

> **In short:** three endpoints for the app, plus two for health checks. All responses are JSON. Every purchase answer carries a machine-readable `code`, so the frontend never has to parse a message.

| Method | Path                     | Purpose                                                                 |
| ------ | ------------------------ | ----------------------------------------------------------------------- |
| GET    | `/api/sale`              | Sale status                                                             |
| POST   | `/api/purchases`         | Try to buy                                                              |
| GET    | `/api/purchases/:userId` | Did this user get one?                                                  |
| GET    | `/health/live`           | Is the process up?                                                      |
| GET    | `/health/ready`          | Are Redis and RabbitMQ reachable? Used to take a server out of rotation |

## GET /api/sale

```json
{
  "saleId": "limited-edition-drop",
  "status": "active",
  "startsAt": "2026-10-13T10:00:00.000Z",
  "endsAt": "2026-10-13T11:00:00.000Z",
  "totalStock": 100,
  "remainingStock": 42,
  "serverTime": "2026-10-13T10:05:00.000Z"
}
```

- `status` is one of `upcoming`, `active`, `sold_out`, `ended` or `paused`.
- `serverTime` lets the app run an accurate countdown even when the device clock is wrong.
- The response carries `Cache-Control: public, max-age=1`, so a CDN could absorb the polling.

## POST /api/purchases

Request:

```json
{ "userId": "alice@example.com" }
```

| HTTP | `code`                           | Meaning                                                                          | Includes `order`? |
| ---- | -------------------------------- | -------------------------------------------------------------------------------- | ----------------- |
| 201  | `purchased`                      | You got one                                                                      | Yes               |
| 409  | `already_purchased`              | You already have one                                                             | Yes, the original |
| 409  | `sold_out`                       | No stock left                                                                    | No                |
| 409  | `sale_not_started`               | Too early                                                                        | No                |
| 409  | `sale_ended`                     | Too late                                                                         | No                |
| 400  | `invalid_user_id`, `bad_request` | Fix the input                                                                    | No                |
| 503  | `sale_paused`                    | The sale is paused for recovery. Try again shortly                               | No                |
| 503  | `service_unavailable`            | Redis or RabbitMQ did not answer. The purchase may have happened, so check first | No                |
| 503  | `overloaded`                     | The server is busy. Try again shortly                                            | No                |

Example of a successful purchase:

```json
{
  "code": "purchased",
  "message": "You secured the item!",
  "order": {
    "orderId": "0b6f8a52-5d0e-4f43-9f5e-6f1f4e3c9a10",
    "userId": "alice@example.com",
    "purchasedAt": "2026-10-13T10:00:00.123Z"
  }
}
```

- **Why 409 for rejections:** the request is valid, but it conflicts with the current state of the sale.
- **`201` and `409 already_purchased` are only sent after RabbitMQ has confirmed the order.** "You have one" therefore always means the order is stored safely.
- **After a `503 service_unavailable`,** the purchase may or may not have happened. Retrying is safe (rule 1 in [Purchase flow](03-purchase-flow.md)), and the app checks `GET /api/purchases/:userId` first.

## GET /api/purchases/:userId

```json
{
  "userId": "alice@example.com",
  "purchased": true,
  "order": { "orderId": "…", "userId": "…", "purchasedAt": "…" }
}
```

```json
{ "userId": "bob", "purchased": false }
```

While the sale is paused for recovery, this endpoint answers `503 sale_paused`, because Redis may not have its buyers back yet.

## User IDs

- 3 to 128 characters: letters, digits and `. _ @ + -`.
- Normalised before use: Unicode NFKC, trimmed, lower-cased.
- Responses always show the normalised form.

---

Previous: [4. Data model](04-data-model.md) · Next: [6. Consistency and recovery](06-consistency-and-recovery.md)
