// src/i18n/i18n.types.ts
//
// Deriving the type from `en` and requiring `pt` to satisfy it is what
// makes a missing or mistyped key in either file a compile error instead
// of a runtime blank string in production. If you add a new enum value
// to the schema, add it here too — TypeScript will refuse to build until
// both locale files have it.

import { en } from './locales/en';

export type Locale = 'pt' | 'en';

// en.ts is declared `as const`, so `typeof en` gives LITERAL types —
// occupied is the type "Occupied", not string. Using that directly as the
// contract for pt.ts is unsatisfiable: it would require the Portuguese
// file to contain the English words verbatim. Widen the leaves to `string`
// while leaving the key structure intact, so a missing/extra/misnested key
// is still a compile error but the translated text is free.
type WidenLeaves<T> = T extends string
  ? string
  : { [K in keyof T]: WidenLeaves<T[K]> };

export type TranslationKeys = WidenLeaves<typeof en>;

// Dot-path of every leaf key, e.g. 'invoice.status.paid' — used as the
// argument type for t() so a typo'd key path is also a compile error.
type Leaves<T, P extends string = ''> = T extends string
  ? P
  : { [K in keyof T]: Leaves<T[K], P extends '' ? `${K & string}` : `${P}.${K & string}`> }[keyof T];

export type TranslationKey = Leaves<TranslationKeys>;
