import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Envelope, newEnvelope } from '@fn/tsevents';
import { SagaInstance, SagaStep } from './saga.entity';
import { OutboxMessage } from '../outbox/outbox.entity';

/**
 * The dispatch saga, modelled explicitly.
 *
 *   reserve_funds     compensate → release_funds
 *   await_response    compensate → none (nothing to undo)
 *   confirm_funds     compensate → release_funds
 *   settle            terminal
 *
 * A step that cannot be undone is marked non-compensatable, which forces the
 * ordering question every saga has to answer: put irreversible steps LAST, so
 * that anything before them can still be rolled back. Sending an email is the
 * classic example -- once it is out, no compensation exists.
 */
const STEPS = [
  { name: 'reserve_funds',  compensatable: true },
  { name: 'await_response', compensatable: false },
  { name: 'confirm_funds',  compensatable: true },
  { name: 'settle',         compensatable: false },
];

@Injectable()
export class DispatchSaga {
  private readonly log = new Logger('DispatchSaga');
  constructor(@InjectDataSource() private ds: DataSource) {}

  async start(workOrderId: number, assignmentId: number, correlationId: string, context: any) {
    return this.ds.transaction(async (m) => {
      const saga = await m.save(m.create(SagaInstance, {
        sagaType: 'dispatch', correlationId, workOrderId, assignmentId,
        status: 'running', currentStep: STEPS[0].name, context,
      }));
      for (const [i, s] of STEPS.entries()) {
        await m.save(m.create(SagaStep, {
          sagaId: saga.id, stepName: s.name, position: i,
          compensatable: s.compensatable, status: 'pending',
        }));
      }
      this.log.log(`saga#${saga.id} started for assignment ${assignmentId}`);
      return saga;
    });
  }

  /** Events advance or fail the saga. The orchestrator owns the transitions. */
  async onEvent(env: Envelope) {
    const aid = env.payload.assignment_id;
    if (!aid) return;
    const saga = await this.ds.getRepository(SagaInstance).findOne({
      where: { assignmentId: aid }, order: { id: 'DESC' } });
    if (!saga || ['completed', 'compensated', 'failed'].includes(saga.status)) return;

    switch (env.type) {
      case 'payment.hold_placed':
        await this.complete(saga, 'reserve_funds', `hold ${env.payload.hold_id}`);
        await this.advance(saga, 'await_response');
        break;

      case 'payment.failed':
        await this.fail(saga, 'reserve_funds', env.payload.reason);
        // Nothing in the choreography unwinds a mid-flight funding failure, so
        // here the orchestrator genuinely does own the rollback and issues it.
        await this.compensate(saga, `funding failed: ${env.payload.reason}`, true);
        break;

      case 'workorder.accepted':
        await this.complete(saga, 'await_response', 'technician accepted');
        await this.complete(saga, 'confirm_funds', 'hold confirmed');
        await this.advance(saga, 'settle');
        break;

      case 'workorder.rejected':
        await this.complete(saga, 'await_response',
          env.payload.expired ? 'offer expired' : 'technician declined');
        // RECORD the compensation, do not re-issue it. The choreographed path
        // already releases the hold in response to this same event; publishing a
        // cancel here would release it twice. Two coordinators must never both
        // act on the same state -- the orchestrator observes and records where
        // choreography already acts, and only issues commands for failures
        // nothing else handles.
        await this.compensate(saga, env.payload.reason || 'declined', false);
        break;

      case 'workorder.completed':
        await this.complete(saga, 'settle', 'approved and captured');
        await this.finish(saga);
        break;
    }
  }

  private step(sagaId: number, name: string) {
    return this.ds.getRepository(SagaStep).findOne({ where: { sagaId, stepName: name } });
  }

  private async complete(saga: SagaInstance, name: string, detail: string) {
    await this.ds.query(
      `UPDATE saga_steps SET status='completed', detail=$3, settled_at=now()
        WHERE saga_id=$1 AND step_name=$2 AND status='pending'`, [saga.id, name, detail]);
  }

  private async fail(saga: SagaInstance, name: string, detail: string) {
    await this.ds.query(
      `UPDATE saga_steps SET status='failed', detail=$3, settled_at=now()
        WHERE saga_id=$1 AND step_name=$2`, [saga.id, name, detail]);
  }

  private async advance(saga: SagaInstance, name: string) {
    await this.ds.query(`UPDATE saga_instances SET current_step=$2 WHERE id=$1`, [saga.id, name]);
  }

  /**
   * Roll back completed, compensatable steps in REVERSE order.
   *
   * Reverse matters: later steps may depend on earlier ones, so undoing them
   * forwards can leave the system in a state neither step anticipated.
   */
  private async compensate(saga: SagaInstance, reason: string, issueCommands: boolean) {
    // Only one compensation may run per saga. Events arrive concurrently on
    // separate queues, so without this guard two of them can interleave and
    // leave the instance stuck in 'compensating'.
    const claimed = await this.ds.query(
      `UPDATE saga_instances SET status='compensating', last_error=$2
        WHERE id=$1 AND status='running' RETURNING id`, [saga.id, reason]);
    if (!claimed.length) return;

    // Raw query: rows are snake_case columns, not hydrated entities. Typing this
    // as SagaStep[] compiles but lies -- the same mistake twice in this codebase.
    const done: any[] = await this.ds.query(
      `SELECT * FROM saga_steps WHERE saga_id=$1 AND status='completed' AND compensatable=true
        ORDER BY position DESC`, [saga.id]);

    for (const s of done) {
      // The compensation for both funding steps is the same: release the hold.
      // Published as an event, so payments performs it -- the orchestrator
      // decides WHAT must be undone, never HOW.
      if (issueCommands &&
          (s.step_name === 'reserve_funds' || s.step_name === 'confirm_funds')) {
        const env = newEnvelope('workorder.cancelled', {
          work_order_id: saga.workOrderId, assignment_id: saga.assignmentId,
          technician_id: saga.context?.technician_id ?? null,
          reason: `saga compensation: ${reason}`,
          cancelled_at: new Date().toISOString(),
        }, { correlationId: saga.correlationId });
        await this.ds.getRepository(OutboxMessage).save(
          this.ds.getRepository(OutboxMessage).create({ eventType: env.type, envelope: env }));
      }
      await this.ds.query(
        `UPDATE saga_steps SET status='compensated', settled_at=now() WHERE id=$1`, [s.id]);
      this.log.warn(`saga#${saga.id} compensated ${s.step_name}` +
        (issueCommands ? ' (command issued)' : ' (already undone by choreography)'));
    }
    await this.ds.query(
      `UPDATE saga_instances SET status='compensated', completed_at=now() WHERE id=$1`, [saga.id]);
  }

  private async finish(saga: SagaInstance) {
    await this.ds.query(
      `UPDATE saga_instances SET status='completed', completed_at=now() WHERE id=$1`, [saga.id]);
    this.log.log(`saga#${saga.id} completed`);
  }

  /** The thing choreography cannot give you: where is this transaction now. */
  async view(limit = 25) {
    return this.ds.query(
      `SELECT s.id, s.saga_type, s.status, s.current_step, s.work_order_id, s.assignment_id,
              s.correlation_id, s.last_error, s.started_at, s.completed_at,
              json_agg(json_build_object('step', st.step_name, 'position', st.position,
                       'status', st.status, 'compensatable', st.compensatable,
                       'detail', st.detail) ORDER BY st.position) AS steps
         FROM saga_instances s JOIN saga_steps st ON st.saga_id = s.id
        GROUP BY s.id ORDER BY s.id DESC LIMIT $1`, [limit]);
  }
}
