import { Body, Controller, Get, Param, Post, Query, Req, ParseIntPipe, HttpCode } from '@nestjs/common';
import { IsInt, IsOptional, IsString, IsNumber } from 'class-validator';
import { AssignmentsService } from './assignments.service';
import { AdminBusService } from './admin-bus.service';
import { Public, RequirePermissions } from '../auth/jwt.strategy';
import { P } from '../auth/permissions';

class DispatchDto {
  @IsInt() work_order_id: number;
  @IsInt() technician_id: number;
  @IsOptional() @IsNumber() match_score?: number;
}
class RejectDto { @IsOptional() @IsString() reason?: string; }
class SubmitDto {
  @IsOptional() @IsNumber() hours_worked?: number;
  @IsOptional() @IsString() note?: string;
}
class ReworkDto { @IsString() reason: string; }

@Controller()
export class AssignmentsController {
  constructor(private svc: AssignmentsService, private bus: AdminBusService) {}

  @Public() @Get('health')
  health() { return { service: 'work-orders', status: 'ok' }; }

  /** Hirer dispatches a work order to a chosen technician. */
  @Post('assignments') @RequirePermissions(P.WORKORDER_DISPATCH)
  dispatch(@Body() dto: DispatchDto, @Req() req: any) {
    return this.svc.dispatch(dto.work_order_id, dto.technician_id, req.user, dto.match_score);
  }

  @Post('assignments/:id/accept') @HttpCode(200) @RequirePermissions(P.ASSIGNMENT_ACCEPT)
  accept(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.svc.respond(id, true, req.user);
  }

  @Post('assignments/:id/reject') @HttpCode(200) @RequirePermissions(P.ASSIGNMENT_REJECT)
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: RejectDto, @Req() req: any) {
    return this.svc.respond(id, false, req.user, dto.reason);
  }

  /** Technician reports the work finished. */
  @Post('assignments/:id/submit') @HttpCode(200) @RequirePermissions(P.ASSIGNMENT_ACCEPT)
  submit(@Param('id', ParseIntPipe) id: number, @Body() dto: SubmitDto, @Req() req: any) {
    return this.svc.submitWork(id, req.user, dto.hours_worked, dto.note);
  }

  /** Hirer approves and releases escrow. Technicians do not hold this permission. */
  @Post('assignments/:id/approve') @HttpCode(200) @RequirePermissions(P.WORKORDER_APPROVE)
  approve(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.svc.approveWork(id, req.user);
  }

  @Post('assignments/:id/rework') @HttpCode(200) @RequirePermissions(P.WORKORDER_APPROVE)
  rework(@Param('id', ParseIntPipe) id: number, @Body() dto: ReworkDto) {
    return this.svc.requestRework(id, dto.reason);
  }

  /** A technician sees only their own offers — enforced from the token, not a query param. */
  @Get('assignments/mine') @RequirePermissions(P.ASSIGNMENT_VIEW_OWN)
  mine(@Req() req: any, @Query('status') status?: string) {
    return this.svc.forTechnician(req.user.subject_id,
      status ? status.split(',') as any : undefined);
  }

  @Get('assignments/by-hirer') @RequirePermissions(P.WORKORDER_VIEW)
  byHirer(@Req() req: any) { return this.svc.byHirer(req.user.sub); }

  @Get('work-orders/:id/assignments') @RequirePermissions(P.WORKORDER_VIEW)
  history(@Param('id', ParseIntPipe) id: number) { return this.svc.forWorkOrder(id); }

  /** DIRECT exchange — a command to exactly one service. */
  @Post('commands/payout') @RequirePermissions(P.PAYMENT_RELEASE) @HttpCode(202)
  async payoutCommand(@Body() body: any, @Req() req: any) {
    await this.bus.payoutCommand(body.technician_id, req.user.sub);
    return { accepted: true, note: 'command dispatched to payments via fieldnation.commands (direct)' };
  }

  /** FANOUT — every service gets a copy. */
  @Post('broadcast/taxonomy-reload') @RequirePermissions(P.PLATFORM_ADMIN) @HttpCode(202)
  async broadcastReload() {
    const n = await this.bus.broadcastTaxonomyReload();
    return { accepted: true, fanned_out_to: n, exchange: 'fieldnation.broadcast (fanout)' };
  }

  /** HEADERS — routed on attributes, not on event type. */
  @Post('priority/:id') @RequirePermissions(P.WORKORDER_DISPATCH) @HttpCode(202)
  async priority(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    await this.bus.flagPriority(id, body.priority ?? 'urgent', body.sla ?? 'same_day');
    return { accepted: true, routed_by: 'message headers via fieldnation.priority (headers)' };
  }

  @Post('assignments/expire-stale') @RequirePermissions(P.PLATFORM_ADMIN) @HttpCode(200)
  async expire() { return { expired: await this.svc.expireStale() }; }
}
