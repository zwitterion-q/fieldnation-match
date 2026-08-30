import { TRANSITIONS, assertTransition, IllegalTransition, TERMINAL }
  from '../src/assignments/state-machine';
import { AssignmentStatus } from '../src/assignments/assignment.entity';

/**
 * The state machine is pure data, which is exactly why it is worth testing
 * exhaustively -- every illegal transition can be enumerated rather than
 * sampled, so this suite proves the whole space, not a handful of cases.
 */
describe('assignment state machine', () => {
  const ALL: AssignmentStatus[] = [
    'dispatched', 'accepted', 'rejected', 'expired', 'cancelled', 'submitted', 'completed'];

  it('permits the happy path end to end', () => {
    expect(() => assertTransition('dispatched', 'accepted')).not.toThrow();
    expect(() => assertTransition('accepted', 'submitted')).not.toThrow();
    expect(() => assertTransition('submitted', 'completed')).not.toThrow();
  });

  it('permits rework: submitted returns to accepted', () => {
    expect(() => assertTransition('submitted', 'accepted')).not.toThrow();
  });

  it('rejects every transition not explicitly allowed', () => {
    let checked = 0;
    for (const from of ALL) {
      for (const to of ALL) {
        if (TRANSITIONS[from].includes(to)) continue;
        checked++;
        expect(() => assertTransition(from, to)).toThrow(IllegalTransition);
      }
    }
    // Derived, not hardcoded: every pair minus the edges the machine allows.
    // Hardcoding it means the test needs editing every time a state is added,
    // which is exactly when you least want to be adjusting the assertion.
    const legal = Object.values(TRANSITIONS).reduce((n, t) => n + t.length, 0);
    expect(checked).toBe(ALL.length * ALL.length - legal);
    expect(legal).toBe(8);
  });

  it('treats terminal states as absorbing — nothing leaves them', () => {
    for (const s of TERMINAL) {
      expect(TRANSITIONS[s]).toHaveLength(0);
    }
  });

  it('cannot accept an offer twice', () => {
    expect(() => assertTransition('accepted', 'accepted')).toThrow(/accepted -> accepted/);
  });

  it('cannot resurrect a rejected offer', () => {
    for (const to of ALL) {
      expect(() => assertTransition('rejected', to)).toThrow(IllegalTransition);
    }
  });

  it('cannot skip submission and approve directly from accepted', () => {
    expect(() => assertTransition('accepted', 'completed')).toThrow(IllegalTransition);
  });
});
