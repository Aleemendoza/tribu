import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { inBody } from '../inBody';
import { CURRENCIES, amountText, parseAmount } from '../../lib/expenses';

function CategorySelect({ value, categories, onChange }) {
  return (
    <select className="form-input" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">Sin categoría</option>
      {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
    </select>
  );
}

function Shell({ title, onClose, onSubmit, saving, error, children }) {
  const titleId = useId();
  return inBody(
    <div className="cal-dialog-backdrop" onClick={saving ? undefined : onClose}>
      <div className="meal-dialog expenses-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <div className="meal-dialog-header">
          <h2 id={titleId} className="meal-dialog-title">{title}</h2>
          <button type="button" className="meal-dialog-close" onClick={onClose} aria-label="Cerrar">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <form className="expenses-form" onSubmit={onSubmit}>
          {children}
          {error && <p className="expenses-error" role="alert">{error}</p>}
          <div className="expenses-form-actions">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>Cancelar</button>
            <button type="submit" className="btn-sm" disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button>
          </div>
        </form>
      </div>
    </div>,
  );
}

function CurrencySelect({ value, onChange }) {
  return (
    <select className="form-input" value={value} onChange={(e) => onChange(e.target.value)}>
      {CURRENCIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
    </select>
  );
}

function Field({ label, children }) {
  return <label className="expenses-field"><span>{label}</span>{children}</label>;
}

// One expense of a month. Generated fixed expenses edit the same way.
export function ExpenseDialog({ expense, day, categories, members, onSave, onClose }) {
  const [form, setForm] = useState(() => ({
    description: expense?.description ?? '',
    amount: amountText(expense?.amount_cents),
    currency: expense?.currency ?? 'ARS',
    spent_on: expense?.spent_on ?? day,
    category_id: expense?.category_id ?? null,
    kind: expense?.kind ?? 'variable',
    paid: expense?.paid ?? true,
    paid_by_user_id: expense?.paid_by_user_id ?? null,
    notes: expense?.notes ?? '',
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event) {
    event.preventDefault();
    const amount_cents = parseAmount(form.amount);
    if (amount_cents === null) { setError('Revisá el monto: por ejemplo 1.234,50'); return; }
    if (!form.description.trim()) { setError('Escribí una descripción.'); return; }
    setSaving(true);
    setError('');
    const problem = await onSave({
      description: form.description.trim(),
      amount_cents,
      currency: form.currency,
      spent_on: form.spent_on,
      category_id: form.category_id,
      kind: form.kind,
      paid: form.paid,
      paid_by_user_id: form.paid_by_user_id,
      notes: form.notes.trim() || null,
    });
    setSaving(false);
    if (problem) setError(problem);
  }

  return (
    <Shell title={expense ? 'Editar gasto' : 'Nuevo gasto'} onClose={onClose} onSubmit={submit} saving={saving} error={error}>
      <Field label="Descripción">
        <input className="form-input" value={form.description} maxLength={160} autoFocus onChange={(e) => set('description', e.target.value)} />
      </Field>
      <div className="expenses-form-row">
        <Field label="Monto">
          <input className="form-input" inputMode="decimal" placeholder="1.234,50" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
        </Field>
        <Field label="Moneda">
          <CurrencySelect value={form.currency} onChange={(value) => set('currency', value)} />
        </Field>
      </div>
      <div className="expenses-form-row">
        <Field label="Fecha">
          <input className="form-input" type="date" required value={form.spent_on} onChange={(e) => set('spent_on', e.target.value)} />
        </Field>
        <Field label="Categoría">
          <CategorySelect value={form.category_id} categories={categories} onChange={(value) => set('category_id', value)} />
        </Field>
      </div>
      <div className="expenses-form-row">
        <Field label="Tipo">
          <select className="form-input" value={form.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="variable">Variable</option>
            <option value="fixed">Fijo</option>
          </select>
        </Field>
        <Field label="Quién pagó">
          <select className="form-input" value={form.paid_by_user_id ?? ''} onChange={(e) => set('paid_by_user_id', e.target.value ? Number(e.target.value) : null)}>
            <option value="">Sin indicar</option>
            {members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}
          </select>
        </Field>
      </div>
      <label className="expenses-check">
        <input type="checkbox" checked={form.paid} onChange={(e) => set('paid', e.target.checked)} />
        <span>Ya está pagado</span>
      </label>
      <Field label="Notas">
        <input className="form-input" value={form.notes} maxLength={500} onChange={(e) => set('notes', e.target.value)} />
      </Field>
    </Shell>
  );
}

// A fixed expense: what appears by itself every month.
export function FixedDialog({ fixed, month, categories, onSave, onClose }) {
  const [form, setForm] = useState(() => ({
    name: fixed?.name ?? '',
    amount: amountText(fixed?.amount_cents),
    currency: fixed?.currency ?? 'ARS',
    due_day: fixed?.due_day ?? '',
    category_id: fixed?.category_id ?? null,
    starts_on: (fixed?.starts_on ?? month).slice(0, 7),
    notes: fixed?.notes ?? '',
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event) {
    event.preventDefault();
    const amount_cents = parseAmount(form.amount);
    if (amount_cents === null) { setError('Revisá el monto: por ejemplo 1.234,50'); return; }
    if (!form.name.trim()) { setError('Escribí un nombre.'); return; }
    const due = form.due_day === '' ? null : Number(form.due_day);
    if (due !== null && !(Number.isInteger(due) && due >= 1 && due <= 31)) { setError('El vencimiento es un día del 1 al 31.'); return; }
    setSaving(true);
    setError('');
    const problem = await onSave({
      name: form.name.trim(),
      amount_cents,
      currency: form.currency,
      due_day: due,
      category_id: form.category_id,
      starts_on: `${form.starts_on}-01`,
      notes: form.notes.trim() || null,
    });
    setSaving(false);
    if (problem) setError(problem);
  }

  return (
    <Shell title={fixed ? 'Editar gasto fijo' : 'Nuevo gasto fijo'} onClose={onClose} onSubmit={submit} saving={saving} error={error}>
      <Field label="Nombre">
        <input className="form-input" value={form.name} maxLength={120} autoFocus placeholder="Alquiler" onChange={(e) => set('name', e.target.value)} />
      </Field>
      <div className="expenses-form-row">
        <Field label="Monto estimado">
          <input className="form-input" inputMode="decimal" placeholder="1.234,50" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
        </Field>
        <Field label="Moneda">
          <CurrencySelect value={form.currency} onChange={(value) => set('currency', value)} />
        </Field>
      </div>
      <div className="expenses-form-row">
        <Field label="Día de vencimiento">
          <input className="form-input" inputMode="numeric" placeholder="10" value={form.due_day} onChange={(e) => set('due_day', e.target.value)} />
        </Field>
        <Field label="Desde el mes">
          <input className="form-input" type="month" required value={form.starts_on} onChange={(e) => set('starts_on', e.target.value)} />
        </Field>
      </div>
      <Field label="Categoría">
        <CategorySelect value={form.category_id} categories={categories} onChange={(value) => set('category_id', value)} />
      </Field>
      <Field label="Notas">
        <input className="form-input" value={form.notes} maxLength={500} onChange={(e) => set('notes', e.target.value)} />
      </Field>
      {fixed && <p className="expenses-hint">Un monto nuevo se aplica a los meses que todavía no se generaron.</p>}
    </Shell>
  );
}

export function CategoryDialog({ category, onSave, onClose }) {
  const [name, setName] = useState(category?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    if (!name.trim()) { setError('Escribí un nombre.'); return; }
    setSaving(true);
    setError('');
    const problem = await onSave(name.trim());
    setSaving(false);
    if (problem) setError(problem);
  }

  return (
    <Shell title={category ? 'Renombrar categoría' : 'Nueva categoría'} onClose={onClose} onSubmit={submit} saving={saving} error={error}>
      <Field label="Nombre">
        <input className="form-input" value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
      </Field>
    </Shell>
  );
}
