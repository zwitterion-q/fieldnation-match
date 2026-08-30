import { Controller, Get, Post, Param, Query, ParseIntPipe, HttpCode } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Projector } from './projector.service';
import { Public, RequirePermissions } from '../auth/jwt.strategy';
import { P } from '../auth/permissions';

@Controller()
export class EventStoreController {
  constructor(@InjectDataSource() private ds: DataSource, private projector: Projector) {}

  /** The write side: the raw, append-only log. */
  @Public() @Get('events')
  events(@Query('limit') limit = '50', @Query('type') type?: string) {
    const where = type ? `WHERE event_type = $2` : '';
    return this.ds.query(
      `SELECT global_sequence, stream_type, stream_id, stream_version, event_type,
              correlation_id, causation_id, recorded_at, envelope->'payload' AS payload
         FROM event_store ${where}
        ORDER BY global_sequence DESC LIMIT $1`,
      type ? [Number(limit), type] : [Number(limit)]);
  }

  /** The read side: denormalised, disposable, rebuildable. */
  @Public() @Get('projections/assignments')
  projection(@Query('limit') limit = '25') {
    return this.ds.query(
      `SELECT * FROM assignment_projection ORDER BY assignment_id DESC LIMIT $1`,
      [Number(limit)]);
  }

  @Public() @Get('projections/status')
  async status() {
    const [cp] = await this.ds.query(`SELECT * FROM projection_checkpoint LIMIT 1`);
    const [{ total }] = await this.ds.query(`SELECT count(*)::int AS total FROM event_store`);
    const lag = Number(total) - Number(cp?.last_sequence ?? 0);
    return {
      projection: cp?.name, last_sequence: cp?.last_sequence,
      events_in_log: Number(total), events_applied: cp?.events_applied,
      // Consumer lag on the read side. Persistently non-zero means the read
      // model is falling behind writes -- the number that tells a user why the
      // dashboard disagrees with what they just did.
      projection_lag: lag > 0 ? lag : 0,
      updated_at: cp?.updated_at,
    };
  }

  /** Fold one aggregate's stream into current state — no read model involved. */
  @Public() @Get('events/replay/:streamType/:id')
  replay(@Param('streamType') streamType: string, @Param('id', ParseIntPipe) id: number) {
    return this.projector.replayStream(streamType, id);
  }

  /** Destroy the read model and rebuild it from history. */
  @Post('projections/rebuild') @RequirePermissions(P.PLATFORM_ADMIN) @HttpCode(200)
  rebuild() { return this.projector.rebuild(); }
}
