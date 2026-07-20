// src/i18n/i18n.service.ts
//
// Usage: i18n.t('invoice.status.paid', user.locale) → 'Pago' or 'Paid'.
// This is intentionally simple — no pluralization rules, no ICU message
// format. Add that only if a real string needs it; most of what this
// app translates (status labels, email subject lines) doesn't.

import { Injectable } from '@nestjs/common';
import { en } from './locales/en';
import { pt } from './locales/pt';
import { Locale, TranslationKey, TranslationKeys } from './i18n.types';

const RESOURCES: Record<Locale, TranslationKeys> = { en, pt };

@Injectable()
export class I18nService {
  /** Resolves a dotted key path against the given locale, with optional
   *  {{token}} interpolation for strings like 'invoiceEmailSubject'. */
  t(key: TranslationKey, locale: Locale, vars?: Record<string, string>): string {
    const resource = RESOURCES[locale];
    const value = key.split('.').reduce<unknown>((node, segment) => {
      if (typeof node !== 'object' || node === null) return undefined;
      return (node as Record<string, unknown>)[segment];
    }, resource);

    if (typeof value !== 'string') {
      // Fail loudly rather than silently falling back to the key path —
      // a missing translation should surface in testing, not ship quietly.
      throw new Error(`Missing translation for key '${key}' in locale '${locale}'`);
    }

    if (!vars) return value;
    return Object.entries(vars).reduce(
      (text, [varName, varValue]) => text.replaceAll(`{{${varName}}}`, varValue),
      value,
    );
  }
}
