/**
 * JSON schemas. Fastify validates requests with them and serialises responses with
 * fast-json-stringify, which is faster than JSON.stringify and never leaks unlisted fields.
 */

const order = {
  type: 'object',
  required: ['orderId', 'userId', 'purchasedAt'],
  properties: {
    orderId: { type: 'string' },
    userId: { type: 'string' },
    purchasedAt: { type: 'string' },
  },
} as const;

export const errorResponse = {
  type: 'object',
  required: ['code', 'message'],
  properties: { code: { type: 'string' }, message: { type: 'string' } },
} as const;

export const saleStatusResponse = {
  type: 'object',
  required: [
    'saleId',
    'status',
    'startsAt',
    'endsAt',
    'totalStock',
    'remainingStock',
    'serverTime',
  ],
  properties: {
    saleId: { type: 'string' },
    status: { type: 'string', enum: ['upcoming', 'active', 'sold_out', 'ended', 'paused'] },
    startsAt: { type: 'string' },
    endsAt: { type: 'string' },
    totalStock: { type: 'integer' },
    remainingStock: { type: 'integer' },
    serverTime: { type: 'string' },
  },
} as const;

/** Shape only. The real rules live in the domain (normalizeUserId). */
const userId = { type: 'string', minLength: 1, maxLength: 256 } as const;

export const purchaseBody = {
  type: 'object',
  required: ['userId'],
  properties: { userId },
} as const;

export const userIdParams = {
  type: 'object',
  required: ['userId'],
  properties: { userId },
} as const;

export const purchaseResponse = {
  type: 'object',
  required: ['code', 'message'],
  properties: { code: { type: 'string' }, message: { type: 'string' }, order },
} as const;

export const purchaseLookupResponse = {
  type: 'object',
  required: ['userId', 'purchased'],
  properties: { userId: { type: 'string' }, purchased: { type: 'boolean' }, order },
} as const;
