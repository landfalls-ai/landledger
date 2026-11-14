/**
 * ISO 4217 currencies and their minor-unit exponent (digits after the point): USD 2 (cents), JPY 0, KWD 3. Landledger
 * reports in USD (docs/plan.md, decision 6); the others are here for invoices and FX. A code that isn't listed is
 * refused rather than guessed.
 */
const EXPONENTS: Record<string, number> = {
  AED: 2,
  ARS: 2,
  AUD: 2,
  BHD: 3,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CLP: 0,
  CNY: 2,
  COP: 2,
  CZK: 2,
  DKK: 2,
  EGP: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  MXN: 2,
  MYR: 2,
  NOK: 2,
  NZD: 2,
  OMR: 3,
  PHP: 2,
  PLN: 2,
  RON: 2,
  SAR: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  TND: 3,
  TRY: 2,
  TWD: 2,
  UAH: 2,
  USD: 2,
  VND: 0,
  ZAR: 2,
};

export interface Currency {
  /** The ISO 4217 alphabetic code, upper case. */
  code: string;
  /** Digits after the point in the minor unit. */
  exponent: number;
}

export class UnknownCurrencyError extends Error {
  constructor(readonly code: string) {
    super(`Unknown currency: ${JSON.stringify(code)} (an ISO 4217 code Landledger knows)`);
    this.name = 'UnknownCurrencyError';
  }
}

export function currency(code: string): Currency {
  const exponent = EXPONENTS[code];
  if (exponent === undefined) throw new UnknownCurrencyError(code);
  return { code, exponent };
}

export const isCurrencyCode = (code: string): boolean => Object.hasOwn(EXPONENTS, code);

export const CURRENCY_CODES: readonly string[] = Object.keys(EXPONENTS).sort();

/** The reporting currency (docs/plan.md, decision 6). */
export const REPORTING_CURRENCY = 'USD';
