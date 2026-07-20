// src/i18n/i18n.types.ts
//
// Deriving the type from `en` and requiring `pt` to satisfy it is what
// makes a missing or mistyped key in either file a compile error instead
// of a runtime blank string in production. If you add a new enum value
// to the schema, add it here too — TypeScript will refuse to build until
// both locale files have it.

import { en } from './locales/en';

// Same structure as `en`, but with every leaf widened to `string` — pt.ts
// must match this shape exactly, but its values are Portuguese, not the
// literal English words from en.ts.
type DeepStringify<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>;
};

export type TranslationKeys = DeepStringify<typeof en>;
export type Locale = 'pt' | 'en';

// Dot-path of every leaf key, e.g. 'invoice.status.paid' — used as the
// argument type for t() so a typo'd key path is also a compile error.
type Leaves<T, P extends string = ''> = T extends string
  ? P
  : { [K in keyof T]: Leaves<T[K], P extends '' ? `${K & string}` : `${P}.${K & string}`> }[keyof T];

export type TranslationKey = Leaves<TranslationKeys>;
