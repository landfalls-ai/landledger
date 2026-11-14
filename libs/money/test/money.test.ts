import { describe, expect, it } from 'vitest';
import {
  convert,
  currency,
  CurrencyMismatchError,
  Decimal,
  divRound,
  formatDecimal,
  formatMoney,
  fxRate,
  FxRateMissingError,
  FxTable,
  MAX_MICROS,
  Money,
  MoneyOverflowError,
  parseUnit,
  Quantity,
  Rate,
  split,
  splitEvenly,
  UnitMismatchError,
  UnknownCurrencyError,
  withinFocusTolerance,
} from '../src/index.js';

const usd = (amount: string) => Money.parse(amount, 'USD');

describe('Decimal (T001)', () => {
  it.each([
    ['12', 12n, 0],
    ['-0.034', -34n, 3],
    ['1.50', 150n, 2],
    ['0', 0n, 0],
    ['0.000000000000000001', 1n, 18],
  ])('parses %s exactly', (text, coefficient, scale) => {
    const d = Decimal.parse(text);
    expect(d.coefficient).toBe(coefficient);
    expect(d.scale).toBe(scale);
    expect(d.toString()).toBe(text);
  });

  it.each([
    '',
    ' 1',
    '1e-3',
    '1E3',
    'NaN',
    'Infinity',
    '-Infinity',
    '+1',
    '1,000',
    '.5',
    '5.',
    '0x10',
    '1.0000000000000000001',
  ])('refuses %j', (text) => {
    expect(() => Decimal.parse(text)).toThrow();
  });

  it('refuses numbers at runtime too (the type already does)', () => {
    expect(() => Decimal.from(0.1 as unknown as string)).toThrow(/Numbers are not exact/);
    expect(() => Decimal.from(1 as unknown as string)).toThrow(TypeError);
  });

  it.each([
    ['0.1', '0.2', '0.3', '-0.1', '0.02'],
    ['1.005', '-2', '-0.995', '3.005', '-2.010'],
    ['999999999999.999999', '0.000001', '1000000000000.000000', '999999999999.999998', '999999.999999999999'],
  ])('%s and %s: plus, minus, times', (a, b, sum, diff, product) => {
    expect(Decimal.parse(a).plus(b).toString()).toBe(sum);
    expect(Decimal.parse(a).minus(b).toString()).toBe(diff);
    expect(Decimal.parse(a).times(b).equals(product)).toBe(true);
  });

  it('compares across scales', () => {
    expect(Decimal.parse('1.50').equals('1.5')).toBe(true);
    expect(Decimal.parse('-0.01').compare('0')).toBe(-1);
    expect(Decimal.parse('2').compare('1.999999')).toBe(1);
  });

  it('divides only with a scale and a mode', () => {
    expect(Decimal.parse('1').divide('3', 6, 'halfEven').toString()).toBe('0.333333');
    expect(Decimal.parse('2').divide('3', 2, 'halfAwayFromZero').toString()).toBe('0.67');
    expect(Decimal.parse('-2').divide('3', 2, 'towardZero').toString()).toBe('-0.66');
    expect(() => Decimal.parse('1').divide('0', 2, 'halfEven')).toThrow(/zero/);
    expect(Decimal.parse('2400000').divideExactly('1000000').toString()).toBe('2.4');
    expect(() => Decimal.parse('1').divideExactly('3')).toThrow(/not exact/);
  });
});

describe('rounding modes (T002)', () => {
  it.each([
    // value, halfEven, halfAwayFromZero
    ['2.5', '2', '3'],
    ['3.5', '4', '4'],
    ['-2.5', '-2', '-3'],
    ['-3.5', '-4', '-4'],
    ['2.4999', '2', '2'],
    ['-2.5001', '-3', '-3'],
    ['0.5', '0', '1'],
    ['-0.5', '0', '-1'],
  ])('%s → %s half-even, %s half away from zero', (value, even, away) => {
    expect(Decimal.parse(value).rescale(0, 'halfEven').toString()).toBe(even);
    expect(Decimal.parse(value).rescale(0, 'halfAwayFromZero').toString()).toBe(away);
  });

  it('divRound covers the directed modes', () => {
    expect(divRound(-7n, 2n, 'floor')).toBe(-4n);
    expect(divRound(-7n, 2n, 'ceiling')).toBe(-3n);
    expect(divRound(-7n, 2n, 'towardZero')).toBe(-3n);
    expect(divRound(7n, -2n, 'halfEven')).toBe(-4n);
  });
});

describe('Money (T003)', () => {
  it('is micro-units for every currency', () => {
    expect(usd('12.34').micros).toBe(12_340_000n);
    expect(usd('0.0031').micros).toBe(3_100n);
    expect(Money.parse('1200', 'JPY').micros).toBe(1_200_000_000n);
    expect(Money.parse('1.234', 'BHD').micros).toBe(1_234_000n);
    expect(Money.ofMicros('-1250000', 'USD').toString()).toBe('USD -1.250000');
  });

  it('knows the minor units of USD, JPY and BHD', () => {
    expect(currency('USD').exponent).toBe(2);
    expect(currency('JPY').exponent).toBe(0);
    expect(currency('BHD').exponent).toBe(3);
    expect(() => currency('XXX')).toThrow(UnknownCurrencyError);
    expect(() => currency('usd')).toThrow(UnknownCurrencyError);
  });

  it('refuses more than six decimals unless told how to round', () => {
    expect(() => usd('0.0000005')).toThrow(/rounding mode/);
    expect(Money.parse('0.0000005', 'USD', 'halfEven').micros).toBe(0n);
    expect(Money.parse('0.0000015', 'USD', 'halfEven').micros).toBe(2n);
    expect(usd('1.5000000').micros).toBe(1_500_000n);
  });

  it('adds, subtracts, negates and compares', () => {
    expect(usd('0.1').plus(usd('0.2')).equals(usd('0.3'))).toBe(true);
    expect(usd('1').minus(usd('1.000001')).toString()).toBe('USD -0.000001');
    expect(usd('5').negate().abs().equals(usd('5'))).toBe(true);
    expect(usd('2').compare(usd('10'))).toBe(-1);
    expect(Money.sum([], 'USD').isZero()).toBe(true);
    expect(() => Money.sum([])).toThrow(/currency/);
  });

  it('never mixes currencies', () => {
    expect(() => usd('1').plus(Money.parse('1', 'EUR'))).toThrow(CurrencyMismatchError);
    expect(() => usd('1').compare(Money.parse('1', 'EUR'))).toThrow(CurrencyMismatchError);
    expect(usd('1').equals(Money.parse('1', 'EUR'))).toBe(false);
  });

  it('stays inside Postgres bigint', () => {
    expect(Money.ofMicros(MAX_MICROS, 'USD').micros).toBe(MAX_MICROS);
    expect(() => Money.ofMicros(MAX_MICROS + 1n, 'USD')).toThrow(MoneyOverflowError);
    expect(() => Money.ofMicros(MAX_MICROS, 'USD').plus(usd('0.000001'))).toThrow(MoneyOverflowError);
    expect(() => Money.parse('9300000000000', 'USD')).toThrow(MoneyOverflowError);
  });

  it('refuses numbers and malformed micro-units', () => {
    expect(() => Money.ofMicros(1 as unknown as bigint, 'USD')).toThrow(TypeError);
    expect(() => Money.ofMicros('1.5', 'USD')).toThrow(SyntaxError);
    expect(() => Money.parse(0.1 as unknown as string, 'USD')).toThrow(TypeError);
  });

  it('round-trips JSON as a decimal string, never a JSON number', () => {
    const json = JSON.stringify(usd('-0.0031'));
    expect(json).toBe('{"amount":"-0.003100","currency":"USD"}');
    expect(Money.fromJSON(JSON.parse(json)).equals(usd('-0.0031'))).toBe(true);
  });
});

describe('products, posting and showing (T004)', () => {
  const haikuIn = Rate.of('1', 'USD', '1000000 Tokens');
  const haikuOut = Rate.of('5', 'USD', '1000000 Tokens');

  it('a $0.0031 call keeps its fractions of a cent', () => {
    const call = Money.fromProduct(haikuIn, Quantity.of('1200', 'Tokens')).plus(
      Money.fromProduct(haikuOut, Quantity.of('380', 'Tokens')),
    );
    expect(call.toString()).toBe('USD 0.003100');
    expect(call.toMinor()).toBe(0n); // rounds to $0.00 when shown alone…
    const day = Money.sum(Array.from({ length: 100 }, () => call));
    expect(day.toString()).toBe('USD 0.310000'); // …but a hundred of them are 31 cents, not $0.00
    expect(formatMoney(day)).toBe('$0.31');
    expect(formatMoney(call, { digits: 4 })).toBe('$0.0031');
  });

  it('prices a 2.4 M-token row: $3 per million tokens is $7.20', () => {
    const rate = Rate.of('3', 'USD', '1000000 Tokens');
    const consumed = Quantity.of('2400000', 'Tokens');
    expect(consumed.in('1000000 Tokens').value.toString()).toBe('2.4');
    expect(Money.fromProduct(rate, consumed).toString()).toBe('USD 7.200000');
    expect(
      Money.fromProduct(Rate.of('0.30', 'USD', '1000000 Tokens'), Quantity.of('600000', 'Tokens')).toString(),
    ).toBe('USD 0.180000');
  });

  it('rounds a product half-even to the micro-unit', () => {
    const rate = Rate.of('0.0000005', 'USD', 'Tokens');
    expect(Money.fromProduct(rate, Quantity.of('1', 'Tokens')).micros).toBe(0n); // 0.5 µ → 0 (even)
    expect(Money.fromProduct(rate, Quantity.of('3', 'Tokens')).micros).toBe(2n); // 1.5 µ → 2 (even)
    expect(Money.fromProduct(rate, Quantity.of('-3', 'Tokens')).micros).toBe(-2n);
  });

  it('prices cluster units from the rate card', () => {
    const cpu = Rate.of('0.034', 'USD', 'Core-Hours');
    expect(Money.fromProduct(cpu, Quantity.of('1.25', 'Core-Hours')).toString()).toBe('USD 0.042500');
    expect(() => Money.fromProduct(cpu, Quantity.of('1', 'GiB-Hours'))).toThrow(UnitMismatchError);
  });

  it('posts and shows half away from zero at the minor unit', () => {
    expect(usd('0.005').toMinor()).toBe(1n);
    expect(usd('0.015').toMinor()).toBe(2n);
    expect(usd('0.025').toMinor()).toBe(3n); // half-even would give 2
    expect(usd('-0.025').toMinor()).toBe(-3n);
    expect(usd('-0.025').posted().toString()).toBe('USD -0.030000');
    expect(usd('1234.565').toCsv()).toBe('1234.57');
    expect(Money.parse('1200.5', 'JPY').toMinor()).toBe(1201n);
    expect(Money.parse('0.0005', 'BHD').toCsv()).toBe('0.001');
  });

  it('formats for people', () => {
    expect(formatMoney(usd('1234.5'))).toBe('$1,234.50');
    expect(formatMoney(usd('-12'))).toBe('-$12.00');
    expect(formatMoney(usd('1234.5'), { whole: true })).toBe('$1,235');
    expect(formatMoney(usd('0.025'))).toBe('$0.03');
    expect(formatMoney(Money.parse('1200', 'JPY'))).toBe('¥1,200');
    expect(formatMoney(usd('9'), { display: 'code' })).toMatch(/^USD\s9\.00$/);
    expect(formatDecimal('0.0045')).toBe('0.0045');
    expect(formatDecimal('1250.5')).toBe('1,250.5');
    expect(formatDecimal('0.1', 2)).toBe('0.10');
  });

  it('reads units in FOCUS Unit Format', () => {
    expect(parseUnit('1000000 Tokens')).toEqual({ count: 1_000_000n, base: 'Tokens' });
    expect(parseUnit('GiB-Hours')).toEqual({ count: 1n, base: 'GiB-Hours' });
    expect(() => parseUnit('1M tokens')).toThrow();
    expect(() => parseUnit('')).toThrow();
    expect(() => Rate.of('-1', 'USD', 'GB')).toThrow(/negative/);
  });
});

describe('split (T005)', () => {
  it('gives the remainder to the largest fractions, ties to the lowest index', () => {
    const parts = split(usd('0.000010'), ['1', '1', '1']);
    expect(parts.map((p) => p.micros)).toEqual([4n, 3n, 3n]);
    expect(split(usd('0.000100'), ['0.5', '0.3', '0.2']).map((p) => p.micros)).toEqual([50n, 30n, 20n]);
    expect(split(usd('0.000007'), ['2', '0', '1']).map((p) => p.micros)).toEqual([5n, 0n, 2n]);
  });

  it('splits a negative amount like its absolute value, negated', () => {
    expect(split(usd('-0.000010'), ['1', '1', '1']).map((p) => p.micros)).toEqual([-4n, -3n, -3n]);
  });

  it('splits evenly', () => {
    expect(splitEvenly(usd('1'), 3).map((p) => p.toString())).toEqual(['USD 0.333334', 'USD 0.333333', 'USD 0.333333']);
  });

  it('refuses no weights, negative weights and all-zero weights', () => {
    expect(() => split(usd('1'), [])).toThrow();
    expect(() => split(usd('1'), ['-1', '2'])).toThrow(/negative/);
    expect(() => split(usd('1'), ['0', '0'])).toThrow(/zero/);
    expect(() => splitEvenly(usd('1'), 0)).toThrow();
  });
});

describe('FOCUS tolerance', () => {
  it('is MAX(100 × subunit, √rows × 0.5 × subunit)', () => {
    expect(withinFocusTolerance(usd('1.00'), 1)).toBe(true); // 100 cents
    expect(withinFocusTolerance(usd('1.000001'), 1)).toBe(false);
    // √1,000,000 × 0.005 = $5
    expect(withinFocusTolerance(usd('5'), 1_000_000)).toBe(true);
    expect(withinFocusTolerance(usd('-5.000001'), 1_000_000)).toBe(false);
    expect(withinFocusTolerance(Money.parse('100', 'JPY'), 1)).toBe(true);
  });
});

describe('FX', () => {
  const eurUsd1 = fxRate({ id: 'fx_1', base: 'EUR', quote: 'USD', rate: '1.0800', date: '2026-11-01' });
  const eurUsd2 = fxRate({ id: 'fx_2', base: 'EUR', quote: 'USD', rate: '1.0850', date: '2026-11-10' });
  const eurUsd2b = fxRate({ id: 'fx_3', base: 'EUR', quote: 'USD', rate: '1.0900', date: '2026-11-10' });
  const table = new FxTable([eurUsd1, eurUsd2, eurUsd2b]);

  it('uses the latest recorded rate for the latest date on or before the day, and names it', () => {
    const eur = Money.parse('100', 'EUR');
    expect(table.convert(eur, 'USD', '2026-11-05')).toEqual({ amount: usd('108'), rateId: 'fx_1' });
    expect(table.convert(eur, 'USD', '2026-11-10').rateId).toBe('fx_3');
    expect(table.convert(eur, 'USD', '2026-12-31').amount.toString()).toBe('USD 109.000000');
  });

  it('rounds a conversion half-even to the micro-unit', () => {
    const r = fxRate({ id: 'fx_r', base: 'JPY', quote: 'USD', rate: '0.0066665', date: '2026-11-01' });
    // ¥1 × 0.0066665 = $0.0066665 → 0.006666 (tie to even); ¥3 → 0.0199995 → 0.020000 (tie to even)
    expect(convert(Money.parse('1', 'JPY'), 'USD', '2026-11-02', () => r).amount.micros).toBe(6_666n);
    expect(convert(Money.parse('3', 'JPY'), 'USD', '2026-11-02', () => r).amount.micros).toBe(20_000n);
  });

  it('needs no rate for USD → USD', () => {
    expect(convert(usd('5'), 'USD', '2026-11-01', () => undefined)).toEqual({ amount: usd('5'), rateId: null });
  });

  it('refuses when there is no rate, and never inverts one', () => {
    expect(() => table.convert(Money.parse('1', 'EUR'), 'USD', '2026-10-31')).toThrow(FxRateMissingError);
    expect(() => table.convert(usd('1'), 'EUR', '2026-11-20')).toThrow(FxRateMissingError);
    expect(() => convert(usd('1'), 'EUR', '2026-11-20', () => eurUsd1)).toThrow(/doesn't convert/);
    expect(() => fxRate({ id: 'x', base: 'EUR', quote: 'USD', rate: '0', date: '2026-11-01' })).toThrow(/positive/);
    expect(() => fxRate({ id: 'x', base: 'USD', quote: 'USD', rate: '1', date: '2026-11-01' })).toThrow();
  });
});
