import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Account, LedgerEntry, LedgerTransaction, Hold, Payout } from './ledger/entities';
import { OutboxMessage } from './outbox/outbox.entity';
import { ProcessedMessage } from './inbox/processed-message.entity';
import { LedgerService } from './ledger/ledger.service';
import { LedgerController } from './ledger/ledger.controller';
import { HoldsService } from './holds/holds.service';
import { WorkOrdersConsumer } from './inbox/workorders.consumer';
import { CommandsConsumer } from './inbox/commands.consumer';
import { OutboxRelay } from './outbox/outbox.relay';
import { AuthGuard } from './auth/jwt.strategy';
import { MetricsInterceptor, MetricsController } from './auth/metrics';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.PAYMENTS_DSN || 'postgresql://fn:fn@localhost:55435/payments',
      entities: [Account, LedgerEntry, LedgerTransaction, Hold, Payout, OutboxMessage, ProcessedMessage],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([Account, LedgerEntry, LedgerTransaction, Hold, Payout,
                              OutboxMessage, ProcessedMessage]),
    JwtModule.register({ global: true,
      secret: process.env.JWT_SECRET || 'fn-dev-secret-change-me',
      signOptions: { issuer: 'fn-identity' } }),
  ],
  controllers: [LedgerController, MetricsController],
  providers: [LedgerService, HoldsService, WorkOrdersConsumer, CommandsConsumer, OutboxRelay,
              { provide: APP_GUARD, useClass: AuthGuard },
              { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }],
})
export class AppModule {}
