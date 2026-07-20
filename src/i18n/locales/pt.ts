// src/i18n/locales/pt.ts
//
// Namespaced by domain because several tables reuse the same English
// enum word ('pending') for genuinely different states — a flat map
// keyed on the English string alone would mistranslate one of them.
// Every key here corresponds 1:1 to a real CHECK constraint value in
// db/migrations/001_initial_schema.sql — confirmed against the schema,
// not guessed.
//
// The `satisfies TranslationKeys` below is load-bearing: it makes a
// missing key, extra key, or wrong nesting in this file a compile error,
// rather than something that only surfaces when a Portuguese-locale user
// hits a blank string in production. Keep en.ts as the source of truth
// for structure; this file must match it exactly.

import type { TranslationKeys } from '../i18n.types';

export const pt = {
  unit: {
    status: {
      occupied: 'Ocupada',
      vacant: 'Livre',
      maintenance: 'Em manutenção',
    },
  },
  lease: {
    status: {
      pending: 'Pendente',
      active: 'Ativo',
      expired: 'Expirado',
      terminated: 'Rescindido',
    },
  },
  leaseSignature: {
    status: {
      sent: 'Enviado',
      viewed: 'Visualizado',
      signed: 'Assinado',
      declined: 'Recusado',
    },
  },
  invoice: {
    status: {
      pending: 'Pendente',
      paid: 'Pago',
      overdue: 'Em atraso',
      cancelled: 'Cancelado',
    },
  },
  payment: {
    status: {
      initiated: 'Iniciado',
      pending: 'A processar',
      succeeded: 'Concluído',
      failed: 'Falhou',
      refunded: 'Reembolsado',
    },
    method: {
      mpesa: 'M-Pesa',
      emola: 'e-Mola',
      mkesh: 'mKesh',
      multicaixa: 'Multicaixa',
      unitel_money: 'UNITEL Money',
      eft: 'Transferência bancária',
      card: 'Cartão',
    },
  },
  ticket: {
    priority: {
      low: 'Baixa',
      medium: 'Média',
      high: 'Alta',
      urgent: 'Urgente',
    },
    status: {
      open: 'Aberto',
      in_progress: 'Em curso',
      resolved: 'Resolvido',
      cancelled: 'Cancelado',
    },
  },
  subscription: {
    status: {
      trialing: 'Período de teste',
      active: 'Ativo',
      past_due: 'Pagamento em atraso',
      cancelled: 'Cancelado',
    },
  },
  user: {
    role: {
      owner: 'Proprietário',
      property_manager: 'Gestor de propriedades',
      accountant: 'Contabilista',
      renter: 'Inquilino',
    },
  },
  // UI strings not tied to an enum — auth flows, email subjects, nav labels.
  // Kept here rather than in a separate file so a translator only has to
  // open one file per language.
  auth: {
    welcomeEmailSubject: 'Bem-vindo(a) — a sua conta foi criada',
    passwordResetSubject: 'Recuperação de password',
  },
  rent: {
    invoiceEmailSubject: 'Fatura de renda — {{period}}',
    reminderEmailSubject: 'Lembrete: renda por pagar',
    paymentConfirmedSubject: 'Pagamento confirmado',
  },
  nav: {
    dashboard: 'Painel',
    properties: 'Propriedades',
    leases: 'Contratos',
    invoices: 'Faturas',
    maintenance: 'Manutenção',
    settings: 'Definições',
  },
} as const satisfies TranslationKeys;
