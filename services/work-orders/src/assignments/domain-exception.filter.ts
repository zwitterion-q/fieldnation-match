import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { IllegalTransition } from './state-machine';

/**
 * Translates domain errors into HTTP at the boundary.
 *
 * state-machine.ts deliberately knows nothing about NestJS or HTTP -- it is the
 * business rule, and business rules should not import a web framework. This
 * filter is where the transport concern lives.
 *
 * An illegal transition is 409 Conflict, not 400: the request was well-formed,
 * it just lost a race or arrived against state that has already moved on. That
 * distinction matters to a client deciding whether to retry.
 */
@Catch(IllegalTransition)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(err: IllegalTransition, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(HttpStatus.CONFLICT).json({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: err.message,
    });
  }
}
