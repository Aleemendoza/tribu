import { amountText, defaultDay, formatMoney, parseAmount, reportCsv, shiftMonth, shortDay } from '../../lib/expenses';

describe('parseAmount', () => {
  it.each([
    ['1.234,50', 123450],
    ['1234,5', 123450],
    ['1234.50', 123450],
    ['1.234', 123400],
    ['1.234.567', 123456700],
    ['$ 2.500', 250000],
    ['0', 0],
    ['50000000', 5000000000],
  ])('reads %s', (text, cents) => {
    expect(parseAmount(text)).toBe(cents);
  });

  it.each(['', 'abc', '12,345', '-5', '1,2,3', '1.2.3'])('refuses %s', (text) => {
    expect(parseAmount(text)).toBeNull();
  });
});

describe('amounts and days', () => {
  it('writes an amount back so it can be read again', () => {
    expect(amountText(123450)).toBe('1234,50');
    expect(amountText(250000)).toBe('2500');
    expect(amountText(105)).toBe('1,05');
    expect(amountText(null)).toBe('');
    expect(parseAmount(amountText(123405))).toBe(123405);
  });

  it('shows pesos the Argentine way', () => {
    expect(formatMoney(123450).replace(/\s/g, ' ')).toBe('$ 1.234,50');
  });

  it('moves across years', () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });

  it('proposes today only in the current month', () => {
    const today = new Date(2026, 10, 5);
    expect(defaultDay({ year: 2026, month: 11 }, today)).toBe('2026-11-05');
    expect(defaultDay({ year: 2026, month: 10 }, today)).toBe('2026-10-01');
  });

  it('reads a day without time zones', () => {
    expect(shortDay('2026-11-05')).toBe('05/11');
  });
});

describe('reportCsv', () => {
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1, total_cents: i === 0 ? 150050 : 0, fixed_cents: 0, variable_cents: i === 0 ? 150050 : 0, pending_cents: 0,
  }));
  const report = {
    months,
    total_cents: 150050,
    categories: [{ category_id: 1, name: 'Luz; gas', months: [150050, ...Array(11).fill(0)], total_cents: 150050 }],
  };

  it('uses semicolons, decimal commas and keeps accents for Excel', () => {
    const csv = reportCsv(report);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0].startsWith('Categoría;Enero;Febrero')).toBe(true);
    expect(lines[1].startsWith('"Luz; gas";1500,50;0,00')).toBe(true);
    expect(lines[1].endsWith(';1500,50')).toBe(true);
    expect(lines[2].startsWith('Total;1500,50')).toBe(true);
  });
});
