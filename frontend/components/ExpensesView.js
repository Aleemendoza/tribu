import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Pencil, Plus, Trash2 } from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import ConfirmDialog from './ConfirmDialog';
import { CategoryDialog, ExpenseDialog, FixedDialog } from './expenses/ExpenseDialog';
import * as api from '../lib/api';
import { MONTH_NAMES, defaultDay, formatMoney, isoDay, reportCsv, shiftMonth, shortDay } from '../lib/expenses';

const TABS = [['month', 'Mes'], ['fixed', 'Fijos'], ['report', 'Reporte anual'], ['categories', 'Categorías']];

const ERRORS = {
  EXPENSE_CATEGORY_EXISTS: 'Ya existe una categoría con ese nombre.',
  EXPENSE_CATEGORY_NOT_FOUND: 'Esa categoría ya no existe. Recargá la página.',
  EXPENSE_NOT_FOUND: 'Ese gasto ya no existe. Recargá la página.',
  FIXED_EXPENSE_NOT_FOUND: 'Ese gasto fijo ya no existe. Recargá la página.',
  EXPENSE_PAYER_NOT_MEMBER: 'Quien pagó tiene que ser de la familia.',
};

function problemOf(result) {
  if (result?.ok) return '';
  return ERRORS[result?.data?.detail?.code] || 'No se pudo guardar. Probá de nuevo.';
}

function Total({ label, cents, tone }) {
  return (
    <div className={`expenses-total${tone ? ` ${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{formatMoney(cents)}</strong>
    </div>
  );
}

function MonthTab({ familyId, members, categories, categoryName }) {
  const [period, setPeriod] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const memberName = (id) => members.find((member) => member.user_id === id)?.display_name || '';

  const load = useCallback(async () => {
    const result = await api.apiGetExpenses(familyId, period.year, period.month);
    setFailed(!result.ok);
    if (result.ok) setData(result.data);
  }, [familyId, period]);

  useEffect(() => { load(); }, [load]);

  async function save(values) {
    const result = dialog.expense
      ? await api.apiUpdateExpense(dialog.expense.id, values)
      : await api.apiCreateExpense({ family_id: Number(familyId), ...values });
    const problem = problemOf(result);
    if (!problem) { setDialog(null); await load(); }
    return problem;
  }

  async function togglePaid(item) {
    const result = await api.apiUpdateExpense(item.id, { paid: !item.paid });
    if (result.ok) await load();
    else setFailed(true);
  }

  const summary = data?.summary;
  return (
    <>
      <div className="expenses-bar">
        <div className="expenses-month-nav">
          <button type="button" className="btn-ghost" aria-label="Mes anterior" onClick={() => setPeriod((p) => shiftMonth(p, -1))}><ChevronLeft size={18} aria-hidden="true" /></button>
          <strong>{MONTH_NAMES[period.month - 1]} {period.year}</strong>
          <button type="button" className="btn-ghost" aria-label="Mes siguiente" onClick={() => setPeriod((p) => shiftMonth(p, 1))}><ChevronRight size={18} aria-hidden="true" /></button>
        </div>
        <button type="button" className="btn-sm" onClick={() => setDialog({})}><Plus size={16} aria-hidden="true" /> Nuevo gasto</button>
      </div>

      {failed && <p className="expenses-error" role="alert">No se pudieron cargar o guardar los gastos. Recargá la página.</p>}

      {summary && (
        <div className="expenses-totals">
          <Total label="Total del mes" cents={summary.total_cents} tone="main" />
          <Total label="Fijos" cents={summary.fixed_cents} />
          <Total label="Variables" cents={summary.variable_cents} />
          <Total label="Falta pagar" cents={summary.pending_cents} tone={summary.pending_cents > 0 ? 'pending' : ''} />
        </div>
      )}

      {data && (data.items.length === 0 ? (
        <p className="expenses-empty">No hay gastos cargados en este mes.</p>
      ) : (
        <div className="expenses-table-wrap">
          <table className="expenses-table">
            <thead>
              <tr>
                <th>Fecha</th><th>Descripción</th><th>Categoría</th><th>Tipo</th><th>Quién</th>
                <th className="num">Monto</th><th>Pagado</th><th><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className={item.paid ? '' : 'pending'}>
                  <td>{shortDay(item.spent_on)}</td>
                  <td>
                    {item.description}
                    {item.notes && <small>{item.notes}</small>}
                  </td>
                  <td>{categoryName(item.category_id)}</td>
                  <td>{item.kind === 'fixed' ? 'Fijo' : 'Variable'}</td>
                  <td>{memberName(item.paid_by_user_id)}</td>
                  <td className="num">{formatMoney(item.amount_cents)}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={item.paid}
                      aria-label={`Marcar ${item.description} como pagado`}
                      onChange={() => togglePaid(item)}
                    />
                  </td>
                  <td className="expenses-actions">
                    <button type="button" className="expenses-icon" aria-label={`Editar ${item.description}`} onClick={() => setDialog({ expense: item })}><Pencil size={15} aria-hidden="true" /></button>
                    <button type="button" className="expenses-icon" aria-label={`Borrar ${item.description}`} onClick={() => setConfirm(item)}><Trash2 size={15} aria-hidden="true" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {dialog && (
        <ExpenseDialog
          expense={dialog.expense}
          day={defaultDay(period)}
          categories={categories}
          members={members}
          onSave={save}
          onClose={() => setDialog(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title="Borrar gasto"
          message={confirm.fixed_expense_id
            ? `¿Sacar "${confirm.description}" de este mes? El gasto fijo sigue apareciendo en los otros meses.`
            : `¿Borrar "${confirm.description}"?`}
          confirmLabel="Borrar"
          confirmDanger
          messages={{}}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const result = await api.apiDeleteExpense(confirm.id);
            setConfirm(null);
            setFailed(!result.ok);
            await load();
          }}
        />
      )}
    </>
  );
}

function FixedTab({ familyId, categories, categoryName }) {
  const [items, setItems] = useState(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async () => {
    const result = await api.apiGetFixedExpenses(familyId);
    setFailed(!result.ok);
    if (result.ok) setItems(result.data);
  }, [familyId]);

  useEffect(() => { load(); }, [load]);

  async function save(values) {
    const result = dialog.fixed
      ? await api.apiUpdateFixedExpense(dialog.fixed.id, values)
      : await api.apiCreateFixedExpense({ family_id: Number(familyId), ...values });
    const problem = problemOf(result);
    if (!problem) { setDialog(null); await load(); }
    return problem;
  }

  async function toggleActive(item) {
    const result = await api.apiUpdateFixedExpense(item.id, { active: !item.active });
    setFailed(!result.ok);
    await load();
  }

  const now = new Date();
  const total = (items || []).filter((item) => item.active).reduce((sum, item) => sum + item.amount_cents, 0);

  return (
    <>
      <div className="expenses-bar">
        <p className="expenses-hint">Aparecen solos cada mes como pendientes. El monto real se ajusta en cada mes.</p>
        <button type="button" className="btn-sm" onClick={() => setDialog({})}><Plus size={16} aria-hidden="true" /> Nuevo fijo</button>
      </div>
      {failed && <p className="expenses-error" role="alert">No se pudieron cargar o guardar los gastos fijos. Recargá la página.</p>}
      {items && (items.length === 0 ? (
        <p className="expenses-empty">Todavía no hay gastos fijos. Sumá el alquiler, los servicios o lo que se repita.</p>
      ) : (
        <>
          <div className="expenses-totals"><Total label="Estimado por mes" cents={total} tone="main" /></div>
          <div className="expenses-table-wrap">
            <table className="expenses-table">
              <thead>
                <tr>
                  <th>Nombre</th><th>Categoría</th><th>Vence</th><th className="num">Monto estimado</th><th>Activo</th>
                  <th><span className="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className={item.active ? '' : 'inactive'}>
                    <td>{item.name}{item.notes && <small>{item.notes}</small>}</td>
                    <td>{categoryName(item.category_id)}</td>
                    <td>{item.due_day ? `Día ${item.due_day}` : ''}</td>
                    <td className="num">{formatMoney(item.amount_cents)}</td>
                    <td><input type="checkbox" checked={item.active} aria-label={`${item.name} activo`} onChange={() => toggleActive(item)} /></td>
                    <td className="expenses-actions">
                      <button type="button" className="expenses-icon" aria-label={`Editar ${item.name}`} onClick={() => setDialog({ fixed: item })}><Pencil size={15} aria-hidden="true" /></button>
                      <button type="button" className="expenses-icon" aria-label={`Borrar ${item.name}`} onClick={() => setConfirm(item)}><Trash2 size={15} aria-hidden="true" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ))}
      {dialog && (
        <FixedDialog
          fixed={dialog.fixed}
          month={isoDay(now.getFullYear(), now.getMonth() + 1, 1)}
          categories={categories}
          onSave={save}
          onClose={() => setDialog(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title="Borrar gasto fijo"
          message={`¿Borrar "${confirm.name}"? Deja de aparecer en los meses nuevos; lo ya registrado queda.`}
          confirmLabel="Borrar"
          confirmDanger
          messages={{}}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const result = await api.apiDeleteFixedExpense(confirm.id);
            setConfirm(null);
            setFailed(!result.ok);
            await load();
          }}
        />
      )}
    </>
  );
}

function ReportTab({ familyId }) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [report, setReport] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    api.apiGetExpenseReport(familyId, year).then((result) => {
      if (!active) return;
      setFailed(!result.ok);
      setReport(result.ok ? result.data : null);
    });
    return () => { active = false; };
  }, [familyId, year]);

  function download() {
    const url = URL.createObjectURL(new Blob([reportCsv(report)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `gastos-${year}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="expenses-bar">
        <div className="expenses-month-nav">
          <button type="button" className="btn-ghost" aria-label="Año anterior" onClick={() => setYear((y) => y - 1)}><ChevronLeft size={18} aria-hidden="true" /></button>
          <strong>{year}</strong>
          <button type="button" className="btn-ghost" aria-label="Año siguiente" onClick={() => setYear((y) => y + 1)}><ChevronRight size={18} aria-hidden="true" /></button>
        </div>
        <button type="button" className="btn-ghost" disabled={!report} onClick={download}><Download size={16} aria-hidden="true" /> Exportar CSV</button>
      </div>
      {failed && <p className="expenses-error" role="alert">No se pudo cargar el reporte. Recargá la página.</p>}
      {report && (
        <>
          <div className="expenses-totals">
            <Total label={`Total ${year}`} cents={report.total_cents} tone="main" />
            <Total label="Promedio por mes con gastos" cents={report.monthly_average_cents} />
            <Total label="Fijos" cents={report.months.reduce((sum, row) => sum + row.fixed_cents, 0)} />
            <Total label="Variables" cents={report.months.reduce((sum, row) => sum + row.variable_cents, 0)} />
          </div>
          <div className="expenses-table-wrap">
            <table className="expenses-table report">
              <thead>
                <tr>
                  <th>Categoría</th>
                  {MONTH_NAMES.map((name) => <th key={name} className="num">{name.slice(0, 3)}</th>)}
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {report.categories.map((row) => (
                  <tr key={row.category_id ?? 'none'}>
                    <td>{row.name}</td>
                    {row.months.map((cents, index) => <td key={index} className="num">{cents ? formatMoney(cents) : '–'}</td>)}
                    <td className="num"><strong>{formatMoney(row.total_cents)}</strong></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  {report.months.map((row) => <td key={row.month} className="num">{row.total_cents ? formatMoney(row.total_cents) : '–'}</td>)}
                  <td className="num"><strong>{formatMoney(report.total_cents)}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function CategoriesTab({ familyId, categories, reload }) {
  const [dialog, setDialog] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [failed, setFailed] = useState(false);

  async function save(name) {
    const result = dialog.category
      ? await api.apiUpdateExpenseCategory(dialog.category.id, { name })
      : await api.apiCreateExpenseCategory({ family_id: Number(familyId), name });
    const problem = problemOf(result);
    if (!problem) { setDialog(null); await reload(); }
    return problem;
  }

  return (
    <>
      <div className="expenses-bar">
        <p className="expenses-hint">Agrupan los gastos en los totales y en el reporte anual.</p>
        <button type="button" className="btn-sm" onClick={() => setDialog({})}><Plus size={16} aria-hidden="true" /> Nueva categoría</button>
      </div>
      {failed && <p className="expenses-error" role="alert">No se pudo borrar la categoría. Recargá la página.</p>}
      <ul className="expenses-categories">
        {categories.map((category) => (
          <li key={category.id}>
            <span>{category.name}</span>
            <button type="button" className="expenses-icon" aria-label={`Renombrar ${category.name}`} onClick={() => setDialog({ category })}><Pencil size={15} aria-hidden="true" /></button>
            <button type="button" className="expenses-icon" aria-label={`Borrar ${category.name}`} onClick={() => setConfirm(category)}><Trash2 size={15} aria-hidden="true" /></button>
          </li>
        ))}
      </ul>
      {dialog && <CategoryDialog category={dialog.category} onSave={save} onClose={() => setDialog(null)} />}
      {confirm && (
        <ConfirmDialog
          title="Borrar categoría"
          message={`¿Borrar "${confirm.name}"? Sus gastos quedan sin categoría.`}
          confirmLabel="Borrar"
          confirmDanger
          messages={{}}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const result = await api.apiDeleteExpenseCategory(confirm.id);
            setConfirm(null);
            setFailed(!result.ok);
            await reload();
          }}
        />
      )}
    </>
  );
}

export default function ExpensesView() {
  const { familyId, members } = useApp();
  const [tab, setTab] = useState('month');
  const [categories, setCategories] = useState([]);

  const reloadCategories = useCallback(async () => {
    const result = await api.apiGetExpenseCategories(familyId);
    if (result.ok) setCategories(result.data);
  }, [familyId]);

  useEffect(() => { if (familyId) reloadCategories(); }, [familyId, reloadCategories]);

  const names = useMemo(() => new Map(categories.map((category) => [category.id, category.name])), [categories]);
  const categoryName = useCallback((id) => names.get(id) || 'Sin categoría', [names]);

  if (!familyId) return null;
  return (
    <div className="expenses-page">
      <header className="list-header"><h1>Gastos</h1></header>
      <div className="rewards-tabs" role="tablist" aria-label="Gastos">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`rewards-tab${tab === key ? ' active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'month' && <MonthTab familyId={familyId} members={members || []} categories={categories} categoryName={categoryName} />}
      {tab === 'fixed' && <FixedTab familyId={familyId} categories={categories} categoryName={categoryName} />}
      {tab === 'report' && <ReportTab familyId={familyId} />}
      {tab === 'categories' && <CategoriesTab familyId={familyId} categories={categories} reload={reloadCategories} />}
    </div>
  );
}
