/**
 * Dante Routing Matrix — virtualised
 *
 * Only Dante devices (isDante: true). RAVENNA / Q-SYS excluded.
 *
 * TX columns: filtered by selected TX device (one device at a time to keep columns manageable).
 * RX rows:    virtualised with @tanstack/react-virtual — only visible rows are in the DOM.
 * Filter:     RX search box to narrow rows by device name or channel name.
 *
 * Write actions guarded by Safe Mode (ON by default, requires typing UNLOCK).
 */

import React, { useState, useCallback, useMemo, memo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Lock, Unlock, RefreshCw, AlertTriangle, CheckCircle2, Search, X } from 'lucide-react';
import { NetworkDevice } from '../types';

interface RoutingMatrixProps {
  devices: NetworkDevice[];
}

// ─── Safe Mode unlock modal ───────────────────────────────────────────────────

interface UnlockModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

const UnlockModal: React.FC<UnlockModalProps> = ({ onConfirm, onCancel }) => {
  const [input, setInput] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-slate-800 border border-amber-600 rounded-xl p-6 w-96 shadow-2xl">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={18} className="text-amber-400" />
          <h2 className="text-sm font-bold text-amber-300">Safety Lock</h2>
        </div>
        <p className="text-xs text-slate-400 mb-1">Safe Mode blocks write actions to Dante devices.</p>
        <p className="text-xs text-slate-400 mb-4">Type <span className="font-mono text-amber-300">UNLOCK</span> to allow routing changes in this session.</p>
        <input
          autoFocus
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && input === 'UNLOCK') onConfirm(); if (e.key === 'Escape') onCancel(); }}
          placeholder="Type UNLOCK"
          className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-200 mb-4 focus:outline-none focus:border-amber-500"
        />
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs rounded bg-slate-700 text-slate-300 hover:bg-slate-600">Cancel</button>
          <button
            onClick={onConfirm}
            disabled={input !== 'UNLOCK'}
            className="px-3 py-1.5 text-xs rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Unlock
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToastMsg { message: string; ok: boolean; }

interface TxCol {
  deviceName: string; deviceIp: string; chId: number; chName: string;
}
interface RxRow {
  deviceName: string; deviceIp: string; arcPort: number | null;
  chId: number; chName: string;
  txChannelName: string | null; txHost: string | null;
  subscribed: boolean; statusText: string;
}

// Row height constant for virtualiser
const ROW_H = 28; // px

// ─── Memoized cell ────────────────────────────────────────────────────────────

interface CellProps {
  active: boolean; loading: boolean; title: string;
  cellKey: string; onClickCell: (key: string) => void;
}
const MatrixCell = memo(({ active, loading, title, cellKey, onClickCell }: CellProps) => (
  <td
    onClick={() => onClickCell(cellKey)}
    title={title}
    className={`border-b border-r border-slate-700/40 text-center cursor-pointer w-8
      ${active  ? 'bg-purple-800/60 hover:bg-red-900/60' : 'hover:bg-purple-900/20'}
      ${loading ? 'bg-amber-900/40' : ''}
    `}
    style={{ height: ROW_H }}
  >
    <div className="flex items-center justify-center" style={{ height: ROW_H }}>
      {loading
        ? <RefreshCw size={10} className="text-amber-400 animate-spin" />
        : active ? <CheckCircle2 size={12} className="text-purple-300" /> : null}
    </div>
  </td>
));

// ─── Main component ───────────────────────────────────────────────────────────

const RoutingMatrix: React.FC<RoutingMatrixProps> = ({ devices }) => {
  const [safeMode, setSafeMode]       = useState(true);
  const [showUnlock, setShowUnlock]   = useState(false);
  const [pendingCell, setPendingCell] = useState<string | null>(null);
  const [toast, setToast]             = useState<ToastMsg | null>(null);
  const [rxFilter, setRxFilter]       = useState('');
  const [txDeviceFilter, setTxDeviceFilter] = useState<string>('__all__');

  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Dante-only devices ──────────────────────────────────────────────────────
  const danteDevices = useMemo(
    () => devices.filter(d => d.isDante && !d.isRAVENNA),
    [devices],
  );

  // ── TX device names list ────────────────────────────────────────────────────
  const txDeviceNames = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const d of danteDevices)
      if ((d.txChannelNames || []).length > 0 && !seen.has(d.name)) {
        seen.add(d.name);
        names.push(d.name);
      }
    return names;
  }, [danteDevices]);

  // ── Flat TX column list — filtered by selected TX device, deduplicated ──────
  const txCols = useMemo<TxCol[]>(() => {
    const seen = new Set<string>();
    const cols: TxCol[] = [];
    for (const d of danteDevices) {
      if (txDeviceFilter !== '__all__' && d.name !== txDeviceFilter) continue;
      for (const ch of d.txChannelNames || []) {
        const k = `${d.ip}:${ch.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        cols.push({ deviceName: d.name, deviceIp: d.ip, chId: ch.id, chName: ch.name || `ch${ch.id}` });
      }
    }
    return cols;
  }, [danteDevices, txDeviceFilter]);

  // ── Flat RX row list — deduplicated ────────────────────────────────────────
  const allRxRows = useMemo<RxRow[]>(() => {
    const seen = new Set<string>();
    const rows: RxRow[] = [];
    for (const d of danteDevices)
      for (const ch of d.rxChannelNames || []) {
        const k = `${d.ip}:${ch.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({
          deviceName: d.name, deviceIp: d.ip, arcPort: null,
          chId: ch.id, chName: ch.name || `ch${ch.id}`,
          txChannelName: ch.txChannelName || null, txHost: ch.txHost || null,
          subscribed: ch.subscribed, statusText: ch.statusText,
        });
      }
    return rows;
  }, [danteDevices]);

  // ── RX filter ───────────────────────────────────────────────────────────────
  const rxRows = useMemo<RxRow[]>(() => {
    if (!rxFilter.trim()) return allRxRows;
    const q = rxFilter.toLowerCase();
    return allRxRows.filter(r =>
      r.deviceName.toLowerCase().includes(q) || r.chName.toLowerCase().includes(q)
    );
  }, [allRxRows, rxFilter]);

  // ── TX device header groups ─────────────────────────────────────────────────
  const txDeviceGroups = useMemo(() => {
    const groups: { deviceName: string; span: number }[] = [];
    let i = 0;
    while (i < txCols.length) {
      const name = txCols[i].deviceName;
      let span = 0;
      while (i + span < txCols.length && txCols[i + span].deviceName === name) span++;
      groups.push({ deviceName: name, span });
      i += span;
    }
    return groups;
  }, [txCols]);

  // ── Active crosspoints Set — keyed exactly as cellKey in render ─────────────
  // cellKey = `${rxIp}:${rxChId}:${col.deviceName}:${col.chName}`
  // We must match col.deviceName (from txChannelNames) with row.txHost (from ARC binary).
  // Build a fast lookup: for each subscribed RX row, find the matching TX col by
  // comparing txHost→deviceName and txChannelName→chName (case-insensitive trim).
  const activeSet = useMemo(() => {
    const s = new Set<string>();
    // Build txCol lookup: (deviceName.toLowerCase(), chName.toLowerCase()) → col
    const txColMap = new Map<string, TxCol>();
    for (const col of txCols)
      txColMap.set(`${col.deviceName.toLowerCase().trim()}:${col.chName.toLowerCase().trim()}`, col);

    for (const row of allRxRows) {
      if (!row.subscribed || !row.txHost || !row.txChannelName) continue;
      const lookupKey = `${row.txHost.toLowerCase().trim()}:${row.txChannelName.toLowerCase().trim()}`;
      const matchedCol = txColMap.get(lookupKey);
      if (matchedCol) {
        s.add(`${row.deviceIp}:${row.chId}:${matchedCol.deviceName}:${matchedCol.chName}`);
      }
    }
    return s;
  }, [allRxRows, txCols]);

  // ── Cell dispatch map — only for visible (filtered) TX cols ────────────────
  const cellMap = useMemo(() => {
    const m = new Map<string, { row: RxRow; col: TxCol; active: boolean }>();
    for (const row of rxRows)
      for (const col of txCols) {
        const key = `${row.deviceIp}:${row.chId}:${col.deviceName}:${col.chName}`;
        m.set(key, { row, col, active: activeSet.has(key) });
      }
    return m;
  }, [rxRows, txCols, activeSet]);

  // ── Virtualiser ─────────────────────────────────────────────────────────────
  const virtualiser = useVirtualizer({
    count: rxRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  });

  // ── Callbacks ───────────────────────────────────────────────────────────────
  const showToast = useCallback((message: string, ok: boolean) => {
    setToast({ message, ok });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const onClickCell = useCallback(async (cellKey: string) => {
    if (safeMode) { setShowUnlock(true); return; }
    if (!window.api) return;
    const entry = cellMap.get(cellKey);
    if (!entry) return;
    const { row, col, active } = entry;
    if (pendingCell === cellKey) return;
    setPendingCell(cellKey);
    try {
      if (active) {
        const res = await window.api.arcUnsubscribeRx(row.deviceIp, row.arcPort, row.chId);
        if (res.ok) showToast(`Disconnected ${row.deviceName}.${row.chName}`, true);
        else showToast(`Error: ${res.error || 'unsubscribe failed'}`, false);
      } else {
        const res = await window.api.arcSetSubscription(
          row.deviceIp, row.arcPort, row.chId, col.chName, col.deviceName,
        );
        if (res.ok) showToast(`${row.deviceName}.${row.chName} → ${col.deviceName}.${col.chName}`, true);
        else showToast(`Error: ${res.error || 'subscribe failed'}`, false);
      }
    } finally {
      setPendingCell(null);
    }
  }, [safeMode, pendingCell, cellMap, showToast]);

  // ── Empty states ────────────────────────────────────────────────────────────
  if (danteDevices.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-slate-500 gap-3">
        <div className="text-4xl opacity-30">🎛️</div>
        <p className="text-sm">No Dante devices detected</p>
        <p className="text-xs text-slate-600">Waiting for mDNS / ARC discovery…</p>
      </div>
    );
  }
  if (allRxRows.length === 0 || txDeviceNames.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-slate-500 gap-3">
        <div className="text-4xl opacity-30">🎛️</div>
        <p className="text-sm">{danteDevices.length} Dante device{danteDevices.length > 1 ? 's' : ''} found</p>
        <p className="text-xs text-slate-600">Waiting for channel data from ARC…</p>
      </div>
    );
  }

  const totalRows = virtualiser.getTotalSize();
  const virtualItems = virtualiser.getVirtualItems();

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-700 shrink-0 bg-slate-900">

        {/* Safe mode toggle */}
        {safeMode ? (
          <button onClick={() => setShowUnlock(true)}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-amber-900/40 text-amber-400 border border-amber-700/50 hover:bg-amber-800/50 transition-colors shrink-0">
            <Lock size={11} /> Safe Mode
          </button>
        ) : (
          <button onClick={() => setSafeMode(true)}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-green-900/40 text-green-400 border border-green-700/50 hover:bg-green-800/50 transition-colors shrink-0">
            <Unlock size={11} /> Write Mode
          </button>
        )}

        {/* TX device selector */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-xs text-slate-500">TX:</span>
          <select
            value={txDeviceFilter}
            onChange={e => setTxDeviceFilter(e.target.value)}
            className="text-xs bg-slate-800 border border-slate-600 rounded px-2 py-0.5 text-slate-200 focus:outline-none focus:border-purple-500 max-w-[180px]"
          >
            <option value="__all__">All devices ({txCols.length} ch)</option>
            {txDeviceNames.map(n => {
              const count = txCols.filter(c => c.deviceName === n).length;
              return <option key={n} value={n}>{n} ({count} ch)</option>;
            })}
          </select>
        </div>

        {/* RX search */}
        <div className="flex items-center gap-1 bg-slate-800 border border-slate-600 rounded px-2 py-0.5 min-w-0">
          <Search size={10} className="text-slate-500 shrink-0" />
          <input
            type="text"
            value={rxFilter}
            onChange={e => setRxFilter(e.target.value)}
            placeholder="Filter RX…"
            className="bg-transparent text-xs text-slate-200 outline-none w-28 placeholder-slate-600"
          />
          {rxFilter && (
            <button onClick={() => setRxFilter('')} className="text-slate-500 hover:text-slate-300 shrink-0">
              <X size={10} />
            </button>
          )}
        </div>

        {/* Stats */}
        <span className="text-xs text-slate-600 ml-auto shrink-0">
          {rxRows.length}/{allRxRows.length} RX · {txCols.length} TX · {danteDevices.length} devices
        </span>
      </div>

      {/* ── Sticky thead + virtualised tbody ── */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <table className="border-collapse text-[11px] select-none" style={{ tableLayout: 'fixed' }}>
          <thead className="sticky top-0 z-30">
            {/* TX device row */}
            <tr>
              <th className="sticky left-0 z-40 bg-slate-900 border-b border-r border-slate-700 w-[130px] min-w-[130px] px-2 py-1 text-left text-slate-500 font-normal">
                RX Channel
              </th>
              <th className="sticky left-[130px] z-40 bg-slate-900 border-b border-r border-slate-700 w-[110px] min-w-[110px] px-2 py-1 text-left text-slate-500 font-normal">
                Status
              </th>
              {txDeviceGroups.map(g => (
                <th key={g.deviceName} colSpan={g.span}
                  className="bg-slate-800 border-b border-r border-slate-700 px-2 py-1 text-center text-purple-300 font-semibold whitespace-nowrap">
                  {g.deviceName}
                </th>
              ))}
            </tr>
            {/* TX channel row */}
            <tr>
              <th className="sticky left-0 z-40 bg-slate-900 border-b border-r border-slate-700 w-[130px] min-w-[130px]" />
              <th className="sticky left-[130px] z-40 bg-slate-900 border-b border-r border-slate-700 w-[110px] min-w-[110px]" />
              {txCols.map(col => (
                <th key={`${col.deviceIp}:${col.chId}`}
                  className="bg-slate-900 border-b border-r border-slate-700/60 px-0.5 text-slate-400 font-normal w-8 min-w-[32px]"
                  style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 64 }}
                  title={`${col.deviceName} · ${col.chName}`}>
                  {col.chName}
                </th>
              ))}
            </tr>
          </thead>

          {/* Virtualised tbody — total height spacer + only visible rows rendered */}
          <tbody>
            {/* Top spacer */}
            {virtualItems.length > 0 && virtualItems[0].start > 0 && (
              <tr><td colSpan={2 + txCols.length} style={{ height: virtualItems[0].start, padding: 0 }} /></tr>
            )}

            {virtualItems.map(vItem => {
              const row = rxRows[vItem.index];
              const prevRow = vItem.index > 0 ? rxRows[vItem.index - 1] : null;
              const isNewDevice = !prevRow || prevRow.deviceName !== row.deviceName;
              const statusColor = row.subscribed ? 'text-green-400'
                : row.statusText === 'Dangling' ? 'text-red-400' : 'text-slate-600';

              return (
                <React.Fragment key={`rx:${row.deviceIp}:${row.chId}`}>
                  {isNewDevice && (
                    <tr className="bg-slate-800/60">
                      <td colSpan={2 + txCols.length}
                        className="sticky left-0 px-2 py-0.5 text-[10px] font-semibold text-purple-400 border-t border-slate-700">
                        {row.deviceName}
                      </td>
                    </tr>
                  )}
                  <tr style={{ height: ROW_H }}>
                    <td className="sticky left-0 z-10 bg-slate-900 border-b border-r border-slate-700/60 px-2 text-slate-300 whitespace-nowrap w-[130px] min-w-[130px] truncate"
                      style={{ height: ROW_H }}>
                      {row.chName}
                    </td>
                    <td className={`sticky left-[130px] z-10 bg-slate-900 border-b border-r border-slate-700/60 px-2 whitespace-nowrap w-[110px] min-w-[110px] truncate ${statusColor}`}
                      style={{ height: ROW_H }}>
                      {row.subscribed
                        ? `← ${row.txHost || '?'}.${row.txChannelName || '?'}`
                        : row.statusText === 'Unsubscribed' ? '—' : (row.statusText || '—')}
                    </td>
                    {txCols.map(col => {
                      const cellKey = `${row.deviceIp}:${row.chId}:${col.deviceName}:${col.chName}`;
                      return (
                        <MatrixCell
                          key={`${col.deviceIp}:${col.chId}`}
                          active={activeSet.has(cellKey)}
                          loading={pendingCell === cellKey}
                          cellKey={cellKey}
                          title={activeSet.has(cellKey)
                            ? `Disconnect ${row.deviceName}.${row.chName} from ${col.deviceName}.${col.chName}`
                            : `Route ${col.deviceName}.${col.chName} → ${row.deviceName}.${row.chName}`}
                          onClickCell={onClickCell}
                        />
                      );
                    })}
                  </tr>
                </React.Fragment>
              );
            })}

            {/* Bottom spacer */}
            {virtualItems.length > 0 && (() => {
              const last = virtualItems[virtualItems.length - 1];
              const remaining = totalRows - (last.start + last.size);
              return remaining > 0
                ? <tr><td colSpan={2 + txCols.length} style={{ height: remaining, padding: 0 }} /></tr>
                : null;
            })()}
          </tbody>
        </table>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-xl text-sm font-medium ${
          toast.ok ? 'bg-green-900/90 text-green-200 border border-green-700'
                   : 'bg-red-900/90 text-red-200 border border-red-700'
        }`}>
          {toast.ok
            ? <CheckCircle2 size={14} className="text-green-400" />
            : <AlertTriangle size={14} className="text-red-400" />}
          {toast.message}
        </div>
      )}

      {/* Unlock modal */}
      {showUnlock && (
        <UnlockModal
          onConfirm={() => { setSafeMode(false); setShowUnlock(false); }}
          onCancel={() => setShowUnlock(false)}
        />
      )}
    </div>
  );
};

export default RoutingMatrix;
