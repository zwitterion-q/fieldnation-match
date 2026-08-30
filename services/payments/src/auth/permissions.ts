/**
 * The permission catalogue. Every service imports these names rather than
 * hardcoding strings, so a rename is a compile error instead of a silent
 * authorisation hole.
 */
export const P = {
  WORKORDER_VIEW:     'workorder:view',
  WORKORDER_CREATE:   'workorder:create',
  WORKORDER_DISPATCH: 'workorder:dispatch',
  WORKORDER_CANCEL:   'workorder:cancel',
  WORKORDER_APPROVE:  'workorder:approve',
  ASSIGNMENT_ACCEPT:  'assignment:accept',
  ASSIGNMENT_REJECT:  'assignment:reject',
  ASSIGNMENT_VIEW_OWN:'assignment:view_own',
  TECHNICIAN_VIEW:    'technician:view',
  MATCH_VIEW:         'match:view',
  PAYMENT_VIEW:       'payment:view',
  PAYMENT_RELEASE:    'payment:release',
  LEDGER_VIEW:        'ledger:view',
  USER_MANAGE:        'user:manage',
  PLATFORM_ADMIN:     'platform:admin',
} as const;

export type PermissionName = typeof P[keyof typeof P];

/** Role -> permissions. The only place this mapping exists. */
export const ROLE_MATRIX: Record<string, PermissionName[]> = {
  admin: Object.values(P),

  dispatcher: [
    P.WORKORDER_VIEW, P.WORKORDER_CREATE, P.WORKORDER_DISPATCH, P.WORKORDER_CANCEL,
    P.TECHNICIAN_VIEW, P.MATCH_VIEW, P.PAYMENT_VIEW,
  ],

  // A hirer can dispatch and approve their own work, and see what it costs --
  // but cannot release funds. Separation of duty: the person who approves the
  // work is not the person who releases the money for it.
  hirer: [
    P.WORKORDER_VIEW, P.WORKORDER_CREATE, P.WORKORDER_DISPATCH, P.WORKORDER_CANCEL,
    P.WORKORDER_APPROVE, P.TECHNICIAN_VIEW, P.MATCH_VIEW, P.PAYMENT_VIEW,
  ],

  technician: [
    P.ASSIGNMENT_VIEW_OWN, P.ASSIGNMENT_ACCEPT, P.ASSIGNMENT_REJECT,
    P.WORKORDER_VIEW, P.PAYMENT_VIEW,
  ],

  finance: [P.PAYMENT_VIEW, P.PAYMENT_RELEASE, P.LEDGER_VIEW, P.WORKORDER_VIEW],
};
