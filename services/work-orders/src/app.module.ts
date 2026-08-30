import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { Assignment } from './assignments/assignment.entity';
import { OutboxMessage } from './outbox/outbox.entity';
import { ProcessedMessage } from './inbox/processed-message.entity';
import { AssignmentsService } from './assignments/assignments.service';
import { AdminBusService } from './assignments/admin-bus.service';
import { StranglerService } from './strangler/strangler.service';
import { SagaInstance, SagaStep } from './saga/saga.entity';
import { DispatchSaga } from './saga/dispatch.saga';
import { SagaController } from './saga/saga.controller';
import { StoredEvent, AssignmentProjection, ProjectionCheckpoint } from './eventstore/eventstore.entity';
import { Projector } from './eventstore/projector.service';
import { EventStoreController } from './eventstore/eventstore.controller';
import { StranglerController } from './strangler/strangler.controller';
import { AssignmentsController } from './assignments/assignments.controller';
import { OutboxRelay } from './outbox/outbox.relay';
import { PaymentsConsumer } from './inbox/payments.consumer';
import { AuthGuard } from './auth/jwt.strategy';
import { MetricsInterceptor, MetricsController } from './auth/metrics';
import { DomainExceptionFilter } from './assignments/domain-exception.filter';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.WO_DSN || 'postgresql://fn:fn@localhost:55432/workorders',
      entities: [Assignment, OutboxMessage, ProcessedMessage, SagaInstance, SagaStep,
                 StoredEvent, AssignmentProjection, ProjectionCheckpoint],
      // Creates only this service's own tables; work_orders already exists and
      // is left untouched.
      synchronize: true,
    }),
    TypeOrmModule.forFeature([Assignment, OutboxMessage, ProcessedMessage, SagaInstance, SagaStep,
                              StoredEvent, AssignmentProjection, ProjectionCheckpoint]),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'fn-dev-secret-change-me',
      signOptions: { issuer: 'fn-identity' },
    }),
  ],
  controllers: [AssignmentsController, StranglerController, SagaController,
               EventStoreController, MetricsController],
  providers: [AssignmentsService, AdminBusService, StranglerService, DispatchSaga, Projector, OutboxRelay, PaymentsConsumer,
              { provide: APP_GUARD, useClass: AuthGuard },
              { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
              { provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
export class AppModule {}
