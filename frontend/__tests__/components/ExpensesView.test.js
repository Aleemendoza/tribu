import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExpensesView from '../../components/ExpensesView';

let mockApp;
jest.mock('../../contexts/AppContext', () => ({ useApp: () => mockApp }));
jest.mock('../../lib/api');
const api = require('../../lib/api');

const categories = [{ id: 1, family_id: 1, name: 'Vivienda' }];
const rent = {
  id: 7, family_id: 1, description: 'Alquiler', amount_cents: 40000000, spent_on: '2026-11-10', category_id: 1,
  fixed_expense_id: 3, kind: 'fixed', paid: false, paid_by_user_id: null, notes: null,
};
const monthData = {
  year: 2026, month: 11, items: [rent],
  summary: { total_cents: 40000000, fixed_cents: 40000000, variable_cents: 0, pending_cents: 40000000 },
};

beforeEach(() => {
  jest.resetAllMocks();
  mockApp = { familyId: 1, members: [{ user_id: 1, display_name: 'Ale', is_adult: true }] };
  api.apiGetExpenseCategories.mockResolvedValue({ ok: true, data: categories });
  api.apiGetExpenses.mockResolvedValue({ ok: true, data: monthData });
  api.apiGetFixedExpenses.mockResolvedValue({ ok: true, data: [] });
  api.apiCreateExpense.mockResolvedValue({ ok: true, data: {} });
  api.apiUpdateExpense.mockResolvedValue({ ok: true, data: {} });
});

describe('ExpensesView', () => {
  it('shows the month with its totals and category', async () => {
    render(<ExpensesView />);
    const row = (await screen.findByText('Alquiler')).closest('tr');
    expect(within(row).getByText('Vivienda')).toBeInTheDocument();
    expect(within(row).getByText('Fijo')).toBeInTheDocument();
    expect(screen.getByText('Total del mes')).toBeInTheDocument();
    expect(screen.getByText('Falta pagar')).toBeInTheDocument();
  });

  it('marks a pending expense as paid', async () => {
    render(<ExpensesView />);
    fireEvent.click(await screen.findByLabelText('Marcar Alquiler como pagado'));
    await waitFor(() => expect(api.apiUpdateExpense).toHaveBeenCalledWith(7, { paid: true }));
  });

  it('adds an expense typed the Argentine way', async () => {
    render(<ExpensesView />);
    await screen.findByText('Alquiler');
    fireEvent.click(screen.getByRole('button', { name: /Nuevo gasto/ }));
    fireEvent.change(screen.getByLabelText('Descripción'), { target: { value: 'Pan' } });
    fireEvent.change(screen.getByLabelText('Monto ($)'), { target: { value: '1.234,50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(api.apiCreateExpense).toHaveBeenCalled());
    expect(api.apiCreateExpense.mock.calls[0][0]).toMatchObject({
      family_id: 1, description: 'Pan', amount_cents: 123450, kind: 'variable', paid: true,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the dialog and explains a wrong amount', async () => {
    render(<ExpensesView />);
    await screen.findByText('Alquiler');
    fireEvent.click(screen.getByRole('button', { name: /Nuevo gasto/ }));
    fireEvent.change(screen.getByLabelText('Descripción'), { target: { value: 'Pan' } });
    fireEvent.change(screen.getByLabelText('Monto ($)'), { target: { value: 'mucho' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Revisá el monto');
    expect(api.apiCreateExpense).not.toHaveBeenCalled();
  });

  it('says so when saving fails on the server', async () => {
    api.apiCreateExpense.mockResolvedValue({ ok: false, data: { detail: { code: 'OTHER' } } });
    render(<ExpensesView />);
    await screen.findByText('Alquiler');
    fireEvent.click(screen.getByRole('button', { name: /Nuevo gasto/ }));
    fireEvent.change(screen.getByLabelText('Descripción'), { target: { value: 'Pan' } });
    fireEvent.change(screen.getByLabelText('Monto ($)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo guardar');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the yearly report by category', async () => {
    const months = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1, total_cents: i === 10 ? 40000000 : 0, fixed_cents: i === 10 ? 40000000 : 0, variable_cents: 0, pending_cents: 0,
    }));
    api.apiGetExpenseReport.mockResolvedValue({
      ok: true,
      data: {
        year: 2026, months, total_cents: 40000000, monthly_average_cents: 40000000,
        categories: [{ category_id: 1, name: 'Vivienda', months: months.map((m) => m.total_cents), total_cents: 40000000 }],
      },
    });
    render(<ExpensesView />);
    fireEvent.click(screen.getByRole('tab', { name: 'Reporte anual' }));
    expect(await screen.findByRole('cell', { name: 'Vivienda' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Exportar CSV/ })).toBeEnabled();
  });
});
