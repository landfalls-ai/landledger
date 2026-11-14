import { describe, expect, it } from 'vitest';
import {
  allocate,
  allocateEvenly,
  convert,
  CurrencyMismatchError,
  Decimal,
  divRound,
  formatDecimal,
  formatMoney,
  formatMoneyCsv,
  fxRate,
  FxRateMissingError,
  FxTable,
  Money,
  price,
  Rate,
  UnknownCurrencyError,
} from '../src/index.js';

const usd = (s: string) => Money.parse(s, 'USD');

describe('Decimal', () => {
  it('parses and prints exactly, keeping the written scale', () => {
    expect(Decimal.parse('0.034').toString()).toBe('0.034');
    expect(Decimal.parse('-1.50').toString()).toBe('-1.50');
    expect(Decimal.parse('+7').toString()).toBe('7');
    expect(Decimal.parse('-0.0045').toString()).toBe('-0.0045');
    expect(Decimal.parse('1.500').normalize().toString()).toBe('1.5');
  });

  it('refuses floats, exponents and junk', () => {
    expect(() => Decimal.from(0.1)).toThrow(/Floats are not money/);
    expect(() => Decimal.parse('1e3')).toThrow(SyntaxError);
    expect(() => Decimal.parse('1,000')).toThrow(SyntaxError);
    expect(() => Decimal.parse('.5')).toThrow(SyntaxError);
    expect(Decimal.from(42).toString()).toBe('42');
  });

  it('adds and multiplies without loss (0.1 + 0.2 is 0.3)', () => {
    expect(Decimal.parse('0.1').plus('0.2').toString()).toBe('0.3');
    expect(Decimal.parse('0.034').times('730').toString()).toBe('24.820');
    expect(Decimal.parse('1').dividedBy('3', 6).toString()).toBe('0.333333');
    expect(Decimal.parse('2').dividedBy('3', 2, 'down').toString()).toBe('0.66');
  });

  it('compares across scales', () => {
    expect(Decimal.parse('1.0').equals('1')).toBe(true);
    expect(Decimal.parse('0.0045').compare('0.034')).toBe(-1);
  });
});

describe('rounding modes', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['2.5', { 'half-even': '2', 'half-up': '3', 'half-down': '2', up: '3', down: '2', ceiling: '3', floor: '2' }],
    ['3.5', { 'half-even': '4', 'half-up': '4', 'half-down': '3', up: '4', down: '3', ceiling: '4', floor: '3' }],
    [
      '-2.5',
      { 'half-even': '-2', 'half-up': '-3', 'half-down': '-2', up: '-3', down: '-2', ceiling: '-2', floor: '-3' },
    ],
    ['2.4', { 'half-even': '2', 'half-up': '2', 'half-down': '2', up: '3', down: '2', ceiling: '3', floor: '2' }],
    [
      '-2.6',
      { 'half-even': '-3', 'half-up': '-3', 'half-down': '-3', up: '-3', down: '-2', ceiling: '-2', floor: '-3' },
    ],
  ];
  for (const [value, expected] of cases)
    for (const [mode, out] of Object.entries(expected))
      it(`${value} ${mode} → ${out}`, () => {
        expect(Decimal.parse(value).toFixed(0, mode as never)).toBe(out);
      });

  it('divRound refuses zero', () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });
});

describe('Money', () => {
  it('keeps integer minor units and the currency exponent', () => {
    expect(usd('1234.56').minor).toBe(123456n);
    expect(Money.parse('1200', 'JPY').minor).toBe(1200n);
    expect(Money.parse('1.234', 'KWD').minor).toBe(1234n);
    expect(Money.parse('12.50', 'USD').toCsv()).toBe('12.50');
  });

  it('refuses digits the currency does not have, unless told how to round', () => {
    expect(() => usd('0.125')).toThrow(/pass a rounding mode/);
    expect(usd('1.500').minor).toBe(150n);
    expect(Money.parse('0.125', 'USD', 'half-even').minor).toBe(12n);
    expect(Money.parse('0.135', 'USD', 'half-even').minor).toBe(14n);
    expect(Money.parse('0.125', 'USD', 'half-up').minor).toBe(13n);
  });

  it('refuses unknown currencies and fractional minor units', () => {
    expect(() => Money.ofMinor(1, 'XXX')).toThrow(UnknownCurrencyError);
    expect(() => Money.ofMinor(1.5, 'USD')).toThrow(TypeError);
    expect(() => Money.ofMinor('1.5', 'USD')).toThrow(SyntaxError);
    expect(Money.ofMinor('-9007199254740993', 'USD').minor).toBe(-9007199254740993n);
  });

  it('adds and subtracts the same currency only', () => {
    expect(usd('0.10').plus(usd('0.20')).equals(usd('0.30'))).toBe(true);
    expect(usd('1').minus(usd('2.5')).toCsv()).toBe('-1.50');
    expect(() => usd('1').plus(Money.parse('1', 'EUR'))).toThrow(CurrencyMismatchError);
    expect(() => usd('1').compare(Money.parse('1', 'EUR'))).toThrow(CurrencyMismatchError);
    expect(Money.sum([], 'USD').isZero()).toBe(true);
    expect(() => Money.sum([])).toThrow(RangeError);
  });

  it('round-trips JSON with minor units as a string', () => {
    const m = usd('-12.34');
    expect(m.toJSON()).toEqual({ amountMinor: '-1234', currency: 'USD' });
    expect(Money.fromJSON(JSON.parse(JSON.stringify(m))).equals(m)).toBe(true);
  });

  it('multiplies by a factor with one rounding', () => {
    expect(usd('10.00').times('0.333').toCsv()).toBe('3.33');
    expect(usd('0.05').times('0.5').toCsv()).toBe('0.02'); // 2.5 cents, half-even
    expect(usd('0.05').times('0.5', 'half-up').toCsv()).toBe('0.03');
  });
});

describe('Rate', () => {
  const vcpu = Rate.of('0.034', 'USD', 'vCPU-hour');

  it('prices quantity × rate exactly, rounding once (half-even)', () => {
    expect(vcpu.cost('730').toCsv()).toBe('24.82');
    expect(vcpu.exactCost('1.25').toString()).toBe('0.04250');
    expect(vcpu.cost('1.25').toCsv()).toBe('0.04'); // 4.25 cents → 4
    expect(Rate.of('0.0045', 'USD').cost('1000').toCsv()).toBe('4.50');
    expect(Rate.of('0.0045', 'USD').cost('1').toCsv()).toBe('0.00'); // 0.45 cents
    expect(Rate.of('0.10', 'USD').cost('5').toCsv()).toBe('0.50');
    expect(price('0.5', Rate.of('0.01', 'USD'))).toEqual(Money.ofMinor(0n, 'USD')); // 0.5 cent → 0 (even)
    expect(price('1.5', Rate.of('0.01', 'USD')).minor).toBe(2n); // 1.5 cents → 2 (even)
    expect(price('0.5', Rate.of('0.01', 'USD'), 'half-up').minor).toBe(1n);
  });

  it('is never negative and never a float', () => {
    expect(() => Rate.of('-0.01', 'USD')).toThrow(RangeError);
    expect(() => Rate.of(0.034, 'USD')).toThrow(TypeError);
    expect(vcpu.toString()).toBe('USD 0.034 per vCPU-hour');
  });
});

describe('allocate', () => {
  it('splits so the parts sum to the whole (largest remainder)', () => {
    const parts = allocate(usd('100.00'), [1, 1, 1]);
    expect(parts.map((p) => p.toCsv())).toEqual(['33.34', '33.33', '33.33']);
    expect(Money.sum(parts).equals(usd('100.00'))).toBe(true);
  });

  it('gives leftovers to the largest remainders, ties to the earlier part', () => {
    // 0.05 by 0.3/0.7 → exact 1.5 and 3.5 cents: one unit left; both remainders tie, so the first gets it.
    expect(allocate(usd('0.05'), ['0.3', '0.7']).map((p) => p.minor)).toEqual([2n, 3n]);
    // 10 cents by 1/2/7 → 1, 2, 7 exactly.
    expect(allocate(usd('0.10'), [1, 2, 7]).map((p) => p.minor)).toEqual([1n, 2n, 7n]);
    // 1 cent by 1/3 → the second (remainder 3/4 beats 1/4).
    expect(allocate(usd('0.01'), [1, 3]).map((p) => p.minor)).toEqual([0n, 1n]);
  });

  it('handles negatives (a credit) and zero weights', () => {
    const parts = allocate(usd('-100.00'), [1, 0, 2]);
    expect(parts.map((p) => p.toCsv())).toEqual(['-33.33', '0.00', '-66.67']);
    expect(allocateEvenly(usd('0.05'), 3).map((p) => p.minor)).toEqual([2n, 2n, 1n]);
  });

  it('refuses no weights, negative weights and all-zero weights', () => {
    expect(() => allocate(usd('1'), [])).toThrow(RangeError);
    expect(() => allocate(usd('1'), [1, -1])).toThrow(RangeError);
    expect(() => allocate(usd('1'), [0, 0])).toThrow(RangeError);
  });
});

describe('FX', () => {
  const table = new FxTable([
    fxRate({ base: 'EUR', quote: 'USD', rate: '1.0800', date: '2026-11-01', source: 'test' }),
    fxRate({ base: 'EUR', quote: 'USD', rate: '1.0900', date: '2026-11-10', source: 'test' }),
    fxRate({ base: 'JPY', quote: 'USD', rate: '0.0066', date: '2026-11-01', source: 'test' }),
  ]);

  it('uses the latest rate on or before the day', () => {
    expect(table.rateOn('EUR', 'USD', '2026-11-09').rate.toString()).toBe('1.0800');
    expect(table.rateOn('EUR', 'USD', '2026-11-10').rate.toString()).toBe('1.0900');
    expect(table.rateOn('EUR', 'USD', '2026-12-31').rate.toString()).toBe('1.0900');
    expect(() => table.rateOn('EUR', 'USD', '2026-10-31')).toThrow(FxRateMissingError);
    expect(() => table.rateOn('USD', 'EUR', '2026-11-12')).toThrow(FxRateMissingError); // no silent inverse
  });

  it('converts across exponents with one rounding', () => {
    expect(table.convert(Money.parse('100.00', 'EUR'), 'USD', '2026-11-12').toCsv()).toBe('109.00');
    expect(table.convert(Money.parse('1234', 'JPY'), 'USD', '2026-11-12').toCsv()).toBe('8.14'); // 8.1444
    expect(table.convert(usd('5'), 'USD', '2026-11-12').equals(usd('5'))).toBe(true);
    expect(() => convert(usd('1'), table.rateOn('EUR', 'USD', '2026-11-12'))).toThrow(/converts EUR/);
  });

  it('checks its inputs', () => {
    expect(() => fxRate({ base: 'EUR', quote: 'USD', rate: '0', date: '2026-11-01', source: 's' })).toThrow(RangeError);
    expect(() => fxRate({ base: 'EUR', quote: 'USD', rate: '1', date: '1/11/2026', source: 's' })).toThrow(SyntaxError);
  });
});

describe('formatting', () => {
  it('is en-US for people', () => {
    expect(formatMoney(usd('1234.5'))).toBe('$1,234.50');
    expect(formatMoney(usd('-12'))).toBe('-$12.00');
    expect(formatMoney(usd('48210.49'), { whole: true })).toBe('$48,210');
    expect(formatMoney(usd('0.5'), { whole: true })).toBe('$0'); // half-even
    expect(formatMoney(Money.parse('1200', 'JPY'))).toBe('¥1,200');
    expect(formatMoney(usd('9.99'), { display: 'code' })).toMatch(/^USD\s9\.99$/);
  });

  it('formats big amounts exactly (beyond 2^53 minor units)', () => {
    expect(formatMoney(Money.ofMinor('123456789012345678901', 'USD'))).toBe('$1,234,567,890,123,456,789.01');
  });

  it('is plain for a CSV', () => {
    expect(formatMoneyCsv(usd('-1234.5'))).toBe('-1234.50');
    expect(formatMoneyCsv(Money.ofMinor(5, 'USD'))).toBe('0.05');
  });

  it('shows rates with every digit', () => {
    expect(formatDecimal('0.0045')).toBe('0.0045');
    expect(formatDecimal('1250.5')).toBe('1,250.5');
    expect(formatDecimal('0.1', 2)).toBe('0.10');
    expect(formatDecimal('-1234567')).toBe('-1,234,567');
  });
});
