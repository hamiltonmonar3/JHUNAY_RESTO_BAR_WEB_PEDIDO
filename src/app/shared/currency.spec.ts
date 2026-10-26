import { roundCurrencyForDisplay } from './currency';

describe('roundCurrencyForDisplay', () => {
  it('rounds values displayed with .99 up to the next integer', () => {
    expect(roundCurrencyForDisplay(12.99)).toBe(13);
    expect(roundCurrencyForDisplay(0.99)).toBe(1);
    expect(roundCurrencyForDisplay(12.989)).toBe(13);
  });

  it('leaves other cent values unchanged', () => {
    expect(roundCurrencyForDisplay(12.98)).toBe(12.98);
    expect(roundCurrencyForDisplay(12.9)).toBe(12.9);
  });

  it('rounds negative values to the next integer without changing other amounts', () => {
    expect(roundCurrencyForDisplay(-12.99)).toBe(-12);
    expect(roundCurrencyForDisplay(-12.98)).toBe(-12.98);
  });

  it('preserves non-finite values for the currency formatter to handle', () => {
    expect(roundCurrencyForDisplay(Number.NaN)).toBeNaN();
    expect(roundCurrencyForDisplay(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});
