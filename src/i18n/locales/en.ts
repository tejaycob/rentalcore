// src/i18n/locales/en.ts
//
// Same key structure as pt.ts, deliberately — the type derived from this
// file (see i18n.types.ts) is what guarantees pt.ts can't silently drift
// out of sync (missing a key, typo'd nesting) as the schema grows.

export const en = {
  unit: {
    status: {
      occupied: 'Occupied',
      vacant: 'Vacant',
      maintenance: 'Under maintenance',
    },
  },
  lease: {
    status: {
      pending: 'Pending',
      active: 'Active',
      expired: 'Expired',
      terminated: 'Terminated',
    },
  },
  leaseSignature: {
    status: {
      sent: 'Sent',
      viewed: 'Viewed',
      signed: 'Signed',
      declined: 'Declined',
    },
  },
  invoice: {
    status: {
      pending: 'Pending',
      paid: 'Paid',
      overdue: 'Overdue',
      cancelled: 'Cancelled',
    },
  },
  payment: {
    status: {
      initiated: 'Initiated',
      pending: 'Processing',
      succeeded: 'Completed',
      failed: 'Failed',
      refunded: 'Refunded',
    },
    method: {
      mpesa: 'M-Pesa',
      emola: 'e-Mola',
      mkesh: 'mKesh',
      multicaixa: 'Multicaixa',
      unitel_money: 'UNITEL Money',
      eft: 'Bank transfer',
      card: 'Card',
    },
  },
  ticket: {
    priority: {
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      urgent: 'Urgent',
    },
    status: {
      open: 'Open',
      in_progress: 'In progress',
      resolved: 'Resolved',
      cancelled: 'Cancelled',
    },
  },
  subscription: {
    status: {
      trialing: 'Trial',
      active: 'Active',
      past_due: 'Past due',
      cancelled: 'Cancelled',
    },
  },
  user: {
    role: {
      owner: 'Owner',
      property_manager: 'Property manager',
      accountant: 'Accountant',
      renter: 'Renter',
    },
  },
  auth: {
    welcomeEmailSubject: 'Welcome — your account has been created',
    passwordResetSubject: 'Password reset',
  },
  rent: {
    invoiceEmailSubject: 'Rent invoice — {{period}}',
    reminderEmailSubject: 'Reminder: rent payment due',
    paymentConfirmedSubject: 'Payment confirmed',
  },
  nav: {
    dashboard: 'Dashboard',
    properties: 'Properties',
    leases: 'Leases',
    invoices: 'Invoices',
    maintenance: 'Maintenance',
    settings: 'Settings',
  },
} as const;
