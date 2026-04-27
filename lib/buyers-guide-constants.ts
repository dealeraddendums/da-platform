export type BgKey =
  | 'english-as-is-warranty'
  | 'english-implied'
  | 'spanish-as-is-warranty'
  | 'spanish-implied';

export const BG_KEYS: BgKey[] = [
  'english-as-is-warranty',
  'english-implied',
  'spanish-as-is-warranty',
  'spanish-implied',
];

export const BG_LABELS: Record<BgKey, string> = {
  'english-as-is-warranty': 'English — As Is / Warranty',
  'english-implied': 'English — Implied Warranties Only',
  'spanish-as-is-warranty': 'Spanish — Como Está / Garantía',
  'spanish-implied': 'Spanish — Solo Garantías Implícitas',
};
