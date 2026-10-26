export function roundCurrencyForDisplay(value: number): number {
  if (!Number.isFinite(value)) return value;

  const cents = Math.round(value * 100);
  if (Math.abs(cents) % 100 !== 99) return value;

  return Math.ceil(cents / 100);
}
