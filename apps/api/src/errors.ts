import type { FastifyReply, FastifyRequest } from 'fastify';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function sendError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const appError =
    error instanceof AppError
      ? error
      : new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
  if (!(error instanceof AppError)) request.log.error(error);
  return reply.code(appError.statusCode).send({
    error: {
      code: appError.code,
      message: appError.message,
      requestId: request.id,
      ...appError.details,
    },
  });
}
