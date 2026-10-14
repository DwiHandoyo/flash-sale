import { DependencyUnavailableError } from '@flash-sale/shared/errors';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import { SaleNotInitializedError, SalePausedError } from '../../app/errors';
import { InvalidUserIdError } from '../../domain/user-id';
import { SALE_PAUSED } from './responses';

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof InvalidUserIdError) {
    return reply.code(400).send({ code: 'invalid_user_id', message: error.message });
  }
  if (error.validation) {
    return reply.code(400).send({ code: 'bad_request', message: error.message });
  }
  if (error instanceof SalePausedError) {
    return reply.code(503).header('retry-after', '2').send(SALE_PAUSED);
  }
  if (error instanceof SaleNotInitializedError) {
    return reply
      .code(503)
      .header('retry-after', '5')
      .send({ code: 'sale_not_initialized', message: 'The sale is not available yet.' });
  }
  if (error instanceof DependencyUnavailableError) {
    request.log.warn({ err: error.cause, dependency: error.dependency }, 'Dependency unavailable');
    return reply.code(503).header('retry-after', '1').send({
      code: 'service_unavailable',
      message:
        'The sale is temporarily unavailable. If you were buying, check your purchase before trying again.',
    });
  }
  if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
    // Fastify's own client errors, such as malformed JSON or an oversized body.
    return reply.code(error.statusCode).send({ code: 'bad_request', message: error.message });
  }

  request.log.error({ err: error }, 'Unhandled error');
  return reply
    .code(500)
    .send({ code: 'internal_error', message: 'Something went wrong. Please try again.' });
}
