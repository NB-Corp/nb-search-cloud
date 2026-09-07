import type { FastifyInstance } from 'fastify';
import { schemaReady } from '../db/migrate.js';
import { pingDatabase } from '../db/transaction.js';
import { sendRequestError } from '../request-context.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health/live', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.code(200).send({ status: 'ok' });
  });

  app.get('/health/ready', async (request, reply) => {
    try {
      const context = request.server.cloud;
      if (!(await pingDatabase(context.db)) || !(await schemaReady(context.db.pool))) {
        reply.header('Cache-Control', 'no-store');
        return reply.code(503).send({ status: 'not_ready' });
      }
      reply.header('Cache-Control', 'no-store');
      return reply.code(200).send({ status: 'ready' });
    } catch (error) {
      return sendRequestError(reply, error);
    }
  });

}
