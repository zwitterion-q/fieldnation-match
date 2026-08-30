import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { newEnvelope, Envelope } from '@fn/tsevents';
import { Assignment, AssignmentStatus } from './assignment.entity';
import { OutboxMessage } from '../outbox/outbox.entity';
import { assertTransition } from './state-machine';
import { DispatchSaga } from '../saga/dispatch.saga';
import { Projector } from '../eventstore/projector.service';

const OFFER_WINDOW_MINUTES = 30;

@Injectable()
export class AssignmentsService {
  constructor(
    @InjectRepository(Assignment) private repo: Repository<Assignment>,
    @InjectDataSource() private ds: DataSource,
    private saga: DispatchSaga,
    private projector: Projector,
  ) {}

  /**
   * Dispatch a work order to a technician.
   *
   * Everything below happens in ONE transaction: the work order flips to
   * dispatched, the assignment row is created, and the event is written to the
   * outbox. If any of it fails, none of it happened.
   */
  async dispatch(workOrderId: number, technicianId: number, actor: any,
                 matchScore?: number) {
    return this.ds.transaction(async (m) => {
      // Row lock: two dispatchers racing on the same work order must serialise,
      // or both would see status='open' and both would dispatch it.
      const wo = await m.query(
        `SELECT work_order_id, title, company, status, pay_rate, pay_type, duration_hours
           FROM work_orders WHERE work_order_id = $1 FOR UPDATE`, [workOrderId]);
      if (!wo.length) throw new NotFoundException('work order not found');
      const order = wo[0];
      if (order.status !== 'open') {
        throw new BadRequestException(`work order is ${order.status}, not open`);
      }

      const expiresAt = new Date(Date.now() + OFFER_WINDOW_MINUTES * 60_000);
      const correlationId = newEnvelope('tmp', {}).correlation_id;

      const assignment = await m.save(m.create(Assignment, {
        workOrderId, technicianId,
        hirerUserId: actor.sub,
        buyerCompany: order.company,
        status: 'dispatched' as AssignmentStatus,
        matchScore: matchScore ?? null,
        payRate: order.pay_rate, payType: order.pay_type,
        durationHours: order.duration_hours,
        expiresAt, correlationId,
      }));

      await m.query(
        `UPDATE work_orders SET status = 'assigned' WHERE work_order_id = $1`, [workOrderId]);

      const env = newEnvelope('workorder.dispatched', {
        work_order_id: workOrderId, technician_id: technicianId,
        assignment_id: assignment.id, hirer_id: actor.sub,
        buyer_company: order.company, title: order.title,
        pay_rate: Number(order.pay_rate ?? 0), pay_type: order.pay_type,
        duration_hours: Number(order.duration_hours ?? 0),
        expires_at: expiresAt.toISOString(), match_score: matchScore ?? null,
      }, { correlationId, actor: { id: actor.sub, role: actor.roles?.[0] ?? 'hirer' } });

      await m.save(m.create(OutboxMessage, { eventType: env.type, envelope: env }));
      // Log and outbox in one transaction: the record of what happened and the
      // intent to tell anyone about it either both commit or neither does.
      await this.projector.append(m, 'assignment', assignment.id, env);

      // Orchestrated saga runs ALONGSIDE the choreography, not instead of it.
      // The events still drive the services; this records and coordinates the
      // transaction so its state is observable and its rollback is explicit.
      await this.saga.start(workOrderId, assignment.id, correlationId,
        { technician_id: technicianId, hirer_id: actor.sub,
          pay_rate: Number(order.pay_rate ?? 0) });

      return assignment;
    });
  }

  /** Technician responds. Only the technician the offer belongs to may act. */
  async respond(assignmentId: number, accept: boolean, actor: any, reason?: string) {
    return this.ds.transaction(async (m) => {
      const a = await m.findOne(Assignment, { where: { id: assignmentId }, lock: { mode: 'pessimistic_write' } });
      if (!a) throw new NotFoundException('assignment not found');

      if (actor.subject_type === 'technician' && actor.subject_id !== a.technicianId) {
        throw new ForbiddenException('this assignment belongs to another technician');
      }
      const target: AssignmentStatus = accept ? 'accepted' : 'rejected';
      assertTransition(a.status, target);

      if (new Date() > a.expiresAt && accept) {
        throw new BadRequestException('offer window has expired');
      }

      a.status = target;
      a.respondedAt = new Date();
      if (!accept) a.rejectReason = reason ?? 'declined';
      await m.save(a);

      // Rejection returns the work order to the pool for the next candidate.
      await m.query(`UPDATE work_orders SET status = $1 WHERE work_order_id = $2`,
        [accept ? 'assigned' : 'open', a.workOrderId]);

      const env = newEnvelope(accept ? 'workorder.accepted' : 'workorder.rejected', {
        work_order_id: a.workOrderId, technician_id: a.technicianId,
        assignment_id: a.id, hirer_id: a.hirerUserId,
        ...(accept ? { accepted_at: a.respondedAt.toISOString() }
                   : { reason: a.rejectReason, rejected_at: a.respondedAt.toISOString(), expired: false }),
      }, { correlationId: a.correlationId,
           actor: { id: actor.sub, role: actor.roles?.[0] ?? 'technician' } });

      await m.save(m.create(OutboxMessage, { eventType: env.type, envelope: env }));
      await this.projector.append(m, 'assignment', a.id, env);
      await this.saga.onEvent(env);
      return a;
    });
  }

  /**
   * Technician reports the work done.
   *
   * Deliberately NOT an event: nothing outside work-orders reacts to a
   * submission yet, and publishing an event nobody consumes is cost without
   * benefit. It becomes one the moment notifications or QA need it.
   */
  async submitWork(assignmentId: number, actor: any, hours?: number, note?: string) {
    return this.ds.transaction(async (m) => {
      const a = await m.findOne(Assignment, { where: { id: assignmentId },
        lock: { mode: 'pessimistic_write' } });
      if (!a) throw new NotFoundException('assignment not found');
      if (actor.subject_type === 'technician' && actor.subject_id !== a.technicianId) {
        throw new ForbiddenException('this assignment belongs to another technician');
      }
      assertTransition(a.status, 'submitted');
      a.status = 'submitted';
      a.submittedAt = new Date();
      a.hoursWorked = (hours ?? Number(a.durationHours ?? 0)).toString();
      a.completionNote = note ?? null;
      await m.save(a);
      await m.query(`UPDATE work_orders SET status='assigned' WHERE work_order_id=$1`, [a.workOrderId]);
      return a;
    });
  }

  /**
   * Hirer approves. This is the only path that releases money, and it is
   * gated on workorder:approve -- which technicians do not hold.
   */
  async approveWork(assignmentId: number, actor: any) {
    return this.ds.transaction(async (m) => {
      const a = await m.findOne(Assignment, { where: { id: assignmentId },
        lock: { mode: 'pessimistic_write' } });
      if (!a) throw new NotFoundException('assignment not found');
      assertTransition(a.status, 'completed');

      a.status = 'completed';
      a.approvedAt = new Date();
      await m.save(a);
      await m.query(`UPDATE work_orders SET status='closed' WHERE work_order_id=$1`, [a.workOrderId]);

      const env = newEnvelope('workorder.completed', {
        work_order_id: a.workOrderId, technician_id: a.technicianId,
        assignment_id: a.id, hirer_id: a.hirerUserId,
        hours_worked: Number(a.hoursWorked ?? 0),
        completed_at: a.approvedAt.toISOString(),
      }, { correlationId: a.correlationId,
           actor: { id: actor.sub, role: actor.roles?.[0] ?? 'hirer' } });
      await m.save(m.create(OutboxMessage, { eventType: env.type, envelope: env }));
      await this.projector.append(m, 'assignment', a.id, env);
      await this.saga.onEvent(env);
      return a;
    });
  }

  /** Hirer sends it back for rework rather than approving. */
  async requestRework(assignmentId: number, reason: string) {
    return this.ds.transaction(async (m) => {
      const a = await m.findOne(Assignment, { where: { id: assignmentId },
        lock: { mode: 'pessimistic_write' } });
      if (!a) throw new NotFoundException('assignment not found');
      assertTransition(a.status, 'accepted');
      a.status = 'accepted';
      a.submittedAt = null;
      a.completionNote = `rework requested: ${reason}`;
      await m.save(a);
      return a;
    });
  }

  /** Offers that nobody answered. Run periodically; same outbox discipline. */
  async expireStale(): Promise<number> {
    return this.ds.transaction(async (m) => {
      // Raw query: rows come back as snake_case columns, not entity properties.
      const stale: any[] = await m.query(
        `SELECT id, work_order_id, technician_id, hirer_user_id, correlation_id
           FROM assignments WHERE status = 'dispatched' AND expires_at < now() FOR UPDATE`);
      for (const row of stale) {
        await m.query(`UPDATE assignments SET status='expired', responded_at=now() WHERE id=$1`, [row.id]);
        await m.query(`UPDATE work_orders SET status='open' WHERE work_order_id=$1`, [row.work_order_id]);
        const env = newEnvelope('workorder.rejected', {
          work_order_id: row.work_order_id, technician_id: row.technician_id,
          assignment_id: row.id, hirer_id: row.hirer_user_id,
          reason: 'offer expired', rejected_at: new Date().toISOString(), expired: true,
        }, { correlationId: row.correlation_id });
        await m.save(m.create(OutboxMessage, { eventType: env.type, envelope: env }));
      }
      return stale.length;
    });
  }

  forTechnician(technicianId: number, statuses?: AssignmentStatus[]) {
    const qb = this.repo.createQueryBuilder('a')
      .where('a.technician_id = :technicianId', { technicianId })
      .orderBy('a.created_at', 'DESC');
    if (statuses?.length) qb.andWhere('a.status IN (:...statuses)', { statuses });
    return qb.getMany();
  }

  forWorkOrder(workOrderId: number) {
    return this.repo.find({ where: { workOrderId }, order: { createdAt: 'DESC' } });
  }

  byHirer(hirerUserId: number) {
    return this.repo.find({ where: { hirerUserId }, order: { createdAt: 'DESC' }, take: 100 });
  }
}
