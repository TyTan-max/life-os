import { useMemo, useState } from 'react';
import { Modal } from './UI';
import { parseCSV, normalizeCsvDate, parseCsvAmount, isCreditCardPaymentMerchant, matchCsvCategoryId } from '../lib/csv';
import { suggestCategory, lookupMerchantCategoryId } from '../lib/autoCategorize';
import { newRecord } from '../store';
import type { FinanceAccount, FinanceCategory, Transaction } from '../types';

type AmountMode = 'single' | 'split';

interface ParsedRow {
  date: string;
  merchant: string;
  amount: number;
  isIncome: boolean;
  isDuplicate: boolean;
  isTransferLike: boolean;
  csvCategory: string;
}

const NONE = '';

// A loose but effective match for "this looks like the same transaction already in the ledger":
// same account, same date, same amount (to the cent), same merchant text (case/space-insensitive).
// Good enough to catch a re-exported overlapping date range without needing an external transaction id.
function duplicateKey(accountId: string, date: string, amount: number, merchant: string) {
  return `${accountId}|${date}|${amount.toFixed(2)}|${merchant.trim().toLowerCase()}`;
}

export function ImportTransactionsModal({
  accounts, categories, existingTransactions, merchantCategoryMap, onImport, onClose
}: {
  accounts: FinanceAccount[];
  categories: FinanceCategory[];
  existingTransactions: Transaction[];
  merchantCategoryMap: Record<string, string>;
  onImport: (transactions: Transaction[]) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<'upload' | 'map' | 'preview'>('upload');
  const [error, setError] = useState('');
  const [rows, setRows] = useState<string[][]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? NONE);
  const [dateCol, setDateCol] = useState(NONE);
  const [merchantCol, setMerchantCol] = useState(NONE);
  const [amountMode, setAmountMode] = useState<AmountMode>('single');
  const [amountCol, setAmountCol] = useState(NONE);
  const [flipSign, setFlipSign] = useState(false);
  const [debitCol, setDebitCol] = useState(NONE);
  const [creditCol, setCreditCol] = useState(NONE);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [transferToAccountId, setTransferToAccountId] = useState(NONE);
  const [categoryCol, setCategoryCol] = useState(NONE);

  const headers = hasHeader && rows.length ? rows[0] : rows[0]?.map((_, i) => `Column ${i + 1}`) ?? [];
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const loadFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseCSV(String(reader.result ?? ''));
        if (!parsed.length) { setError('That file has no rows.'); return; }
        setRows(parsed);
        setError('');
        // Guess sensible defaults from header names so most imports need zero manual mapping.
        const header = parsed[0];
        const findCol = (patterns: RegExp) => header.findIndex(h => patterns.test(h.trim()));
        const dateIdx = findCol(/date/i);
        const descIdx = findCol(/desc|merchant|payee|name/i);
        const amountIdx = findCol(/^amount$|^amt$/i);
        const debitIdx = findCol(/debit/i);
        const creditIdx = findCol(/credit/i);
        const categoryIdx = findCol(/^category$/i);
        if (dateIdx >= 0) setDateCol(header[dateIdx]);
        if (descIdx >= 0) setMerchantCol(header[descIdx]);
        if (categoryIdx >= 0) setCategoryCol(header[categoryIdx]);
        if (amountIdx >= 0) {
          setAmountMode('single');
          setAmountCol(header[amountIdx]);
        } else if (debitIdx >= 0 || creditIdx >= 0) {
          setAmountMode('split');
          if (debitIdx >= 0) setDebitCol(header[debitIdx]);
          if (creditIdx >= 0) setCreditCol(header[creditIdx]);
        }
        setStep('map');
      } catch {
        setError('Could not read that file as CSV.');
      }
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsText(file);
  };

  const colIndex = (name: string) => headers.indexOf(name);

  const existingKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const t of existingTransactions) {
      if (t.accountId !== accountId) continue;
      keys.add(duplicateKey(t.accountId, t.date, t.amount, t.merchant));
    }
    return keys;
  }, [existingTransactions, accountId]);

  // Only depends on the merchant column, so it's available on the mapping step (before amount
  // columns are necessarily set) to decide whether to surface the "log these as a transfer" option.
  const hasTransferLikeRows = useMemo(() => {
    const mi = colIndex(merchantCol);
    if (mi < 0) return false;
    return dataRows.some(r => isCreditCardPaymentMerchant((r[mi] ?? '').trim()));
  }, [dataRows, merchantCol]);

  const parsedRows = useMemo<ParsedRow[]>(() => {
    if (step !== 'preview') return [];
    const di = colIndex(dateCol);
    const mi = colIndex(merchantCol);
    const ai = colIndex(amountCol);
    const debI = colIndex(debitCol);
    const credI = colIndex(creditCol);
    const catI = colIndex(categoryCol);
    return dataRows.map(r => {
      const date = di >= 0 ? normalizeCsvDate(r[di] ?? '') : '';
      const merchant = mi >= 0 ? (r[mi] ?? '').trim() : '';
      const csvCategory = catI >= 0 ? (r[catI] ?? '').trim() : '';
      let amount: number;
      let isIncome: boolean;
      if (amountMode === 'single') {
        let n = ai >= 0 ? parseCsvAmount(r[ai] ?? '') : 0;
        if (flipSign) n = -n;
        isIncome = n > 0;
        amount = Math.abs(n);
      } else {
        const debit = debI >= 0 ? Math.abs(parseCsvAmount(r[debI] ?? '')) : 0;
        const credit = credI >= 0 ? Math.abs(parseCsvAmount(r[credI] ?? '')) : 0;
        isIncome = credit > 0 && debit === 0;
        amount = isIncome ? credit : debit;
      }
      const isDuplicate = existingKeys.has(duplicateKey(accountId, date, amount, merchant));
      // Only the "money out" direction is safe to auto-flip to a Transfer here: a Transfer's
      // accountId is always the source, and the account being imported into is the source only
      // when money is leaving it (paying the card), not when it's the destination (a payment
      // received on the card's own statement) — that reverse case is left as Income for the user
      // to fix by hand, rather than guessing and getting the direction backwards.
      const isTransferLike = !isIncome && isCreditCardPaymentMerchant(merchant);
      return { date, merchant, amount, isIncome, isDuplicate, isTransferLike, csvCategory };
    }).filter(r => r.date && r.merchant);
  }, [step, dataRows, dateCol, merchantCol, amountMode, amountCol, debitCol, creditCol, flipSign, existingKeys, accountId, categoryCol]);

  const duplicateCount = parsedRows.filter(r => r.isDuplicate).length;
  const rowsToImport = skipDuplicates ? parsedRows.filter(r => !r.isDuplicate) : parsedRows;

  const canMap = accountId && dateCol && merchantCol && (amountMode === 'single' ? amountCol : (debitCol || creditCol));

  // Priority: (1) a category the user has already picked for this exact merchant before — the
  // strongest signal since it's a deliberate choice; (2) the bank/card issuer's own category for
  // this row, if the file has one and it maps to something here; (3) the generic keyword rules,
  // for files with no category column or one that doesn't match anything.
  const categoryFor = (merchant: string, isIncome: boolean, csvCategory: string) => {
    const kind = isIncome ? 'income' : 'expense';
    const mappedId = lookupMerchantCategoryId(merchant, merchantCategoryMap);
    if (mappedId) {
      const mapped = categories.find(c => c.id === mappedId && c.kind === kind);
      if (mapped) return mapped.id;
    }
    const csvMatch = matchCsvCategoryId(csvCategory, categories, kind);
    if (csvMatch) return csvMatch;
    const suggestion = suggestCategory(merchant);
    if (suggestion) {
      const match = categories.find(c => c.name.toLowerCase() === suggestion.toLowerCase() && c.kind === kind);
      if (match) return match.id;
    }
    return undefined;
  };

  const doImport = () => {
    const records = rowsToImport.map(r => {
      const asTransfer = r.isTransferLike && transferToAccountId && transferToAccountId !== accountId;
      return newRecord<Transaction>({
        date: r.date,
        merchant: r.merchant,
        amount: r.amount,
        type: asTransfer ? 'Transfer' : (r.isIncome ? 'Income' : 'Expense'),
        accountId,
        transferAccountId: asTransfer ? transferToAccountId : undefined,
        categoryId: asTransfer ? undefined : categoryFor(r.merchant, r.isIncome, r.csvCategory)
      });
    });
    onImport(records);
  };

  return (
    <Modal
      eyebrow="Life OS"
      title="Import transactions from CSV"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          {step === 'map' && (
            <button type="button" className="btn teal" disabled={!canMap} onClick={() => setStep('preview')}>Preview</button>
          )}
          {step === 'preview' && (
            <>
              <button type="button" className="btn ghost" onClick={() => setStep('map')}>Back</button>
              <button type="button" className="btn teal" disabled={!rowsToImport.length} onClick={doImport}>
                Import {rowsToImport.length} transaction{rowsToImport.length === 1 ? '' : 's'}
              </button>
            </>
          )}
        </>
      }
    >
      {step === 'upload' && (
        <div className="form-grid">
          <p className="muted">
            Export a transaction history CSV from your bank or card issuer's website, then upload it here.
            Any column layout works — you'll match up the columns on the next step.
          </p>
          <label className="field-full">
            <span>CSV file</span>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={e => { const f = e.target.files?.[0]; if (f) loadFile(f); }}
            />
          </label>
          {error && <p className="form-error field-full">{error}</p>}
        </div>
      )}

      {step === 'map' && (
        <div className="form-grid">
          <label>
            <span>Import into account</span>
            <select value={accountId} onChange={e => setAccountId(e.target.value)}>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label>
            <span>First row is a header</span>
            <select value={hasHeader ? 'yes' : 'no'} onChange={e => setHasHeader(e.target.value === 'yes')}>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          <label>
            <span>Date column</span>
            <select value={dateCol} onChange={e => setDateCol(e.target.value)}>
              <option value={NONE}>—</option>
              {headers.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
          <label>
            <span>Description / merchant column</span>
            <select value={merchantCol} onChange={e => setMerchantCol(e.target.value)}>
              <option value={NONE}>—</option>
              {headers.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
          <label>
            <span>Category column (optional)</span>
            <select value={categoryCol} onChange={e => setCategoryCol(e.target.value)}>
              <option value={NONE}>— None, categorize automatically</option>
              {headers.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
          <label className="field-full">
            <span>Amount format</span>
            <select value={amountMode} onChange={e => setAmountMode(e.target.value as AmountMode)}>
              <option value="single">Single amount column (signed)</option>
              <option value="split">Separate debit and credit columns</option>
            </select>
          </label>
          {amountMode === 'single' ? (
            <>
              <label>
                <span>Amount column</span>
                <select value={amountCol} onChange={e => setAmountCol(e.target.value)}>
                  <option value={NONE}>—</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
              <label>
                <span>Sign convention</span>
                <select value={flipSign ? 'flip' : 'normal'} onChange={e => setFlipSign(e.target.value === 'flip')}>
                  <option value="normal">Negative = money out (expense)</option>
                  <option value="flip">Positive = money out (expense)</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <label>
                <span>Debit / charge column</span>
                <select value={debitCol} onChange={e => setDebitCol(e.target.value)}>
                  <option value={NONE}>—</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
              <label>
                <span>Credit / payment column</span>
                <select value={creditCol} onChange={e => setCreditCol(e.target.value)}>
                  <option value={NONE}>—</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            </>
          )}
          {hasTransferLikeRows && (
            <label className="field-full">
              <span>This file looks like it includes credit card payments — log them as a transfer to</span>
              <select value={transferToAccountId} onChange={e => setTransferToAccountId(e.target.value)}>
                <option value={NONE}>Don't do this — import them as expenses/income</option>
                {accounts.filter(a => a.id !== accountId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          )}
          {error && <p className="form-error field-full">{error}</p>}
        </div>
      )}

      {step === 'preview' && (
        <div className="import-preview">
          <p className="muted">
            Imported rows are added as new transactions. They won't change the account's balance —
            update that yourself once you've reconciled, same as any manually entered transaction.
          </p>
          {duplicateCount > 0 && (
            <label className="import-dedupe-toggle">
              <input type="checkbox" checked={skipDuplicates} onChange={e => setSkipDuplicates(e.target.checked)} />
              <span>
                Skip {duplicateCount} row{duplicateCount === 1 ? '' : 's'} that match{duplicateCount === 1 ? 'es' : ''} a transaction already in this account (same date, amount, and merchant)
              </span>
            </label>
          )}
          <div className="grid-table-wrap grid-table-scroll">
            <table className="grid-table">
              <thead>
                <tr><th>Date</th><th>Merchant</th><th>Amount</th><th>Type</th><th>Category</th><th>Status</th></tr>
              </thead>
              <tbody>
                {parsedRows.slice(0, 50).map((r, i) => {
                  const asTransfer = r.isTransferLike && transferToAccountId && transferToAccountId !== accountId;
                  const categoryId = asTransfer ? undefined : categoryFor(r.merchant, r.isIncome, r.csvCategory);
                  const categoryLabel = categoryId ? categories.find(c => c.id === categoryId)?.name : undefined;
                  const typeLabel = asTransfer ? 'Transfer' : (r.isIncome ? 'Income' : 'Expense');
                  return (
                    <tr key={i} className={r.isDuplicate && skipDuplicates ? 'import-row-skipped' : ''}>
                      <td>{r.date}</td>
                      <td>{r.merchant}</td>
                      <td>{r.amount.toFixed(2)}</td>
                      <td>{typeLabel}</td>
                      <td>{asTransfer ? <span className="muted">—</span> : (categoryLabel ?? <span className="muted">—</span>)}</td>
                      <td>
                        {r.isDuplicate && <span className="import-duplicate-tag">Possible duplicate</span>}
                        {!r.isDuplicate && r.isTransferLike && !transferToAccountId && <span className="import-duplicate-tag">Looks like a card payment</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {parsedRows.length > 50 && <p className="muted">…and {parsedRows.length - 50} more.</p>}
          {!parsedRows.length && <p className="muted">No valid rows found — check your column mapping.</p>}
        </div>
      )}
    </Modal>
  );
}
