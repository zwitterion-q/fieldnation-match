import { Controller, Get, Param, Query, ParseIntPipe } from '@nestjs/common';
import { DispatchSaga } from './dispatch.saga';
import { Public } from '../auth/jwt.strategy';

@Controller('sagas')
export class SagaController {
  constructor(private saga: DispatchSaga) {}

  /** Every in-flight and settled transaction, with each step's state.
   *  This view is precisely what choreography alone cannot give you. */
  @Public() @Get()
  list(@Query('limit') limit = '25') { return this.saga.view(Number(limit)); }
}
