/** Allowed values (FOCUS 1.4 and Landledger's own). */

export const CHARGE_CATEGORIES = ['Usage', 'Purchase', 'Tax', 'Credit', 'Adjustment'] as const;
export type ChargeCategory = (typeof CHARGE_CATEGORIES)[number];

/** Only a correction to a locked (FOCUS: closed) period carries a ChargeClass. */
export const CHARGE_CLASSES = ['Correction'] as const;
export type ChargeClass = (typeof CHARGE_CLASSES)[number];

export const CHARGE_FREQUENCIES = ['One-Time', 'Recurring', 'Usage-Based'] as const;
export type ChargeFrequency = (typeof CHARGE_FREQUENCIES)[number];

export const PRICING_CATEGORIES = ['Standard', 'Dynamic', 'Committed', 'Other'] as const;
export type PricingCategory = (typeof PRICING_CATEGORIES)[number];

/** FOCUS 1.4 ServiceCategory (`servicecategory.md:17`-`:35`). */
export const SERVICE_CATEGORIES = [
  'AI and Machine Learning',
  'Analytics',
  'Business Applications',
  'Compute',
  'Databases',
  'Developer Tools',
  'Multicloud',
  'Identity',
  'Integration',
  'Internet of Things',
  'Management and Governance',
  'Media',
  'Migration',
  'Mobile',
  'Networking',
  'Security',
  'Storage',
  'Web',
  'Other',
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** Every figure says what it is: usage × the rate card, or from an invoice. */
export const BASES = ['estimated', 'invoiced'] as const;
export type Basis = (typeof BASES)[number];

export const SOURCES = ['landflow', 'clickland', 'invoice', 'manual'] as const;
export type Source = (typeof SOURCES)[number];
