// Household expenses: money, months and the yearly CSV.
// Amounts travel as whole cents, in pesos or dollars, written the Argentine way.

export const CURRENCIES = [['ARS', 'Pesos'], ['USD', 'Dólares']];

const moneyFormats = {
  ARS: new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }),
  USD: new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD' }),
};

export const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

export function formatMoney(cents, currency = 'ARS') {
  return moneyFormats[currency].format((cents || 0) / 100);
}

// What someone typed, in whole cents, or null if it is not an amount.
// Reads "1.234,50", "1234,5", "1234.50" and "1.234": a dot followed by exactly
// three digits groups thousands, as it does on an Argentine receipt.
export function parseAmount(text) {
  const clean = String(text ?? '').replace(/[$\s]/g, '');
  if (!clean) return null;
  let normal;
  if (clean.includes(',')) {
    normal = clean.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(clean)) {
    normal = clean.replace(/\./g, '');
  } else {
    normal = clean;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(normal)) return null;
  const [whole, decimals = ''] = normal.split('.');
  return Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
}

// The amount as it goes back into a text field.
export function amountText(cents) {
  if (cents === null || cents === undefined) return '';
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest ? `${whole},${String(rest).padStart(2, '0')}` : String(whole);
}

export function isoDay(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function shiftMonth({ year, month }, by) {
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

// Today if it falls in the month on screen, otherwise that month's first day.
export function defaultDay({ year, month }, today = new Date()) {
  if (today.getFullYear() === year && today.getMonth() + 1 === month) {
    return isoDay(year, month, today.getDate());
  }
  return isoDay(year, month, 1);
}

// "2026-11-05" reads as 05/11, without the time zone moving the day.
export function shortDay(iso) {
  const [, month, day] = String(iso).split('-');
  return `${day}/${month}`;
}

function csvCell(value) {
  const text = String(value);
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// One block per currency, one after the other, since they are never added up.
// Plain decimal numbers with a comma and ";" between cells, as Excel in
// Argentina expects. The leading BOM keeps the accents.
export function reportCsv(reports) {
  const money = (cents) => ((cents || 0) / 100).toFixed(2).replace('.', ',');
  const block = (report) => [
    [`Categoría (${report.currency === 'USD' ? 'dólares' : 'pesos'})`, ...MONTH_NAMES, 'Total'],
    ...report.categories.map((row) => [row.name, ...row.months.map(money), money(row.total_cents)]),
    ['Total', ...report.months.map((row) => money(row.total_cents)), money(report.total_cents)],
    ['Fijos', ...report.months.map((row) => money(row.fixed_cents))],
    ['Variables', ...report.months.map((row) => money(row.variable_cents))],
    ['Pendiente', ...report.months.map((row) => money(row.pending_cents))],
  ];
  const lines = reports.flatMap((report, index) => [...(index ? [[]] : []), ...block(report)]);
  return `﻿${lines.map((line) => line.map(csvCell).join(';')).join('\r\n')}\r\n`;
}
