import { AssignmentStatus } from './assignment.entity';

/**
 * Legal transitions, in one place.
 *
 * Encoding this as data rather than scattering `if (status === ...)` through the
 * service means an illegal transition is impossible to express, and the diagram
 * an engineer draws on a whiteboard is the same object the code enforces.
 */
export const TRANSITIONS: Record<AssignmentStatus, AssignmentStatus[]> = {
  dispatched: ['accepted', 'rejected', 'expired', 'cancelled'],
  // The technician submits; the hirer approves. Two steps, because the party
  // doing the work must not be the party that releases the money for it.
  accepted:   ['submitted', 'cancelled'],
  submitted:  ['completed', 'accepted'],   // back to accepted = rework requested
  rejected:   [],
  expired:    [],
  cancelled:  [],
  completed:  [],
};

export class IllegalTransition extends Error {
  constructor(from: AssignmentStatus, to: AssignmentStatus) {
    super(`illegal transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: AssignmentStatus, to: AssignmentStatus) {
  if (!TRANSITIONS[from]?.includes(to)) throw new IllegalTransition(from, to);
}

export const TERMINAL: AssignmentStatus[] = ['rejected', 'expired', 'cancelled', 'completed'];
