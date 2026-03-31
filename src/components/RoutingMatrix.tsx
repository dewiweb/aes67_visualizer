/**
 * Dante Routing Matrix
 *
 * Displays a TX × RX crosspoint matrix for all Dante devices (isDante: true).
 * RAVENNA / Q-SYS devices are excluded — their routing uses RTSP/SDP.
 *
 * Columns = TX channels (grouped by device)
 * Rows    = RX channels (one row per channel)
 * Cell    = crosspoint: filled = subscribed, empty = not subscribed
 *
 * Write actions (subscribe / unsubscribe) are guarded by Safe Mode.
 * Safe Mode is ON by default — user must unlock explicitly.
 */

import React, { useState, useCallback, useMemo, memo } from 'react';
import { Lock, Unlock, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
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

// ─── Memoized cell — only re-renders when active/loading/title change ────────
// onClick is passed as a stable ref to avoid memo invalidation.

interface CellProps {
  active: boolean;
  loading: boolean;
  title: string;
  cellKey: string;
  onClickCell: (key: string) => void;
}
const MatrixCell = memo(({ active, loading, title, cellKey, onClickCell }: CellProps) => (
  <td
    onClick={() => onClickCell(cellKey)}
    title={title}
    className={`border-b border-r border-slate-700/40 text-center cursor-pointer w-8 h-7
      ${active   ? 'bg-purple-800/60 hover:bg-red-900/60' : 'hover:bg-purple-900/20'}
      ${loading  ? 'bg-amber-900/40' : ''}
    `}
  >
    <div className="flex items-center justify-center h-7">
      {loading
        ? <RefreshCw size={10} className="text-amber-400 animate-spin" />
        : active
          ? <CheckCircle2 size={12} className="text-purple-300" />
          : null
      }
    </div>
  </td>
));

// ─── Main component ───────────────────────────────────────────────────────────

const RoutingMatrix: React.FC<RoutingMatrixProps> = ({ devices }) => {
  const [safeMode, setSafeMode]       = useState(true);
  const [showUnlock, setShowUnlock]   = useState(false);
  const [pendingCell, setPendingCell] = useState<string | null>(null);
  const [toast, setToast]             = useState<ToastMsg | null>(null);

  // Filter to Dante-only devices
  const danteDevices = useMemo(
    () => devices.filter(d => d.isDante && !d.isRAVENNA),
    [devices],
  );

  // Flat TX column list
  const txCols = useMemo<TxCol[]>(() => {
    const cols: TxCol[] = [];
    for (const d of danteDevices)
      for (const ch of d.txChannelNames || [])
        cols.push({ deviceName: d.name, deviceIp: d.ip, chId: ch.id, chName: ch.name || `ch${ch.id}` });
    return cols;
  }, [danteDevices]);

  // Flat RX row list
  const rxRows = useMemo<RxRow[]>(() => {
    const rows: RxRow[] = [];
    for (const d of danteDevices)
      for (const ch of d.rxChannelNames || [])
        rows.push({
          deviceName: d.name, deviceIp: d.ip, arcPort: null,
          chId: ch.id, chName: ch.name || `ch${ch.id}`,
          txChannelName: ch.txChannelName || null, txHost: ch.txHost || null,
          subscribed: ch.subscribed, statusText: ch.statusText,
        });
    return rows;
  }, [danteDevices]);

  // TX device header groups
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

  // Pre-compute active crosspoints as Set<"rxIp:rxChId:txDeviceName:txChName">
  // O(RX_count) build, O(1) lookup per cell — avoids per-cell isCrosspoint scan
  const activeSet = useMemo(() => {
    const s = new Set<string>();
    for (const row of rxRows) {
      if (row.subscribed && row.txHost && row.txChannelName)
        s.add(`${row.deviceIp}:${row.chId}:${row.txHost}:${row.txChannelName}`);
    }
    return s;
  }, [rxRows]);

  const showToast = useCallback((message: string, ok: boolean) => {
    setToast({ message, ok });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Map cellKey → {row, col, active} — rebuilt only when rxRows/txCols/activeSet change
  const cellMap = useMemo(() => {
    const m = new Map<string, { row: RxRow; col: TxCol; active: boolean }>();
    for (const row of rxRows)
      for (const col of txCols) {
        const key = `${row.deviceIp}:${row.chId}:${col.deviceName}:${col.chName}`;
        m.set(key, { row, col, active: activeSet.has(key) });
      }
    return m;
  }, [rxRows, txCols, activeSet]);

  // Single stable handler for all cells — keyed dispatch via cellMap
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

  // ── Empty state ──────────────────────────────────────────────────────────────
  if (danteDevices.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-slate-500 gap-3">
        <div className="text-4xl opacity-30">🎛️</div>
        <p className="text-sm">No Dante devices detected</p>
        <p className="text-xs text-slate-600">Waiting for mDNS / ARC discovery…</p>
      </div>
    );
  }

  if (txCols.length === 0 || rxRows.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-slate-500 gap-3">
        <div className="text-4xl opacity-30">🎛️</div>
        <p className="text-sm">{danteDevices.length} Dante device{danteDevices.length > 1 ? 's' : ''} found</p>
        <p className="text-xs text-slate-600">Waiting for channel data from ARC…</p>
      </div>
    );
  }

  // ── Matrix ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">

      {/* Safe Mode toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-700 shrink-0 bg-slate-900">
        {safeMode ? (
          <button
            onClick={() => setShowUnlock(true)}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-amber-900/40 text-amber-400 border border-amber-700/50 hover:bg-amber-800/50 transition-colors"
          >
            <Lock size={11} /> Safe Mode ON — click to unlock
          </button>
        ) : (
          <button
            onClick={() => setSafeMode(true)}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-green-900/40 text-green-400 border border-green-700/50 hover:bg-green-800/50 transition-colors"
          >
            <Unlock size={11} /> Write Mode — click to re-lock
          </button>
        )}
        <span className="text-xs text-slate-500">
          {danteDevices.length} device{danteDevices.length > 1 ? 's' : ''} · {txCols.length} TX · {rxRows.length} RX
        </span>
        <span className="text-xs text-slate-600 ml-auto">
          RAVENNA / Q-SYS devices excluded (use RTSP/SDP routing)
        </span>
      </div>

      {/* Matrix table */}
      <div className="flex-1 overflow-auto">
        <table className="border-collapse text-[11px] select-none">
          <thead>
            {/* TX device name row */}
            <tr>
              <th className="sticky left-0 z-20 bg-slate-900 border-b border-r border-slate-700 min-w-[120px] max-w-[180px] px-2 py-1 text-left text-slate-500 font-normal">
                RX Channel
              </th>
              <th className="sticky left-[120px] z-20 bg-slate-900 border-b border-r border-slate-700 min-w-[80px] px-2 py-1 text-left text-slate-500 font-normal">
                Status
              </th>
              {txDeviceGroups.map(g => (
                <th
                  key={g.deviceName}
                  colSpan={g.span}
                  className="bg-slate-800 border-b border-r border-slate-700 px-2 py-1 text-center text-purple-300 font-semibold whitespace-nowrap"
                >
                  {g.deviceName}
                </th>
              ))}
            </tr>
            {/* TX channel name row */}
            <tr>
              <th className="sticky left-0 z-20 bg-slate-900 border-b border-r border-slate-700" />
              <th className="sticky left-[120px] z-20 bg-slate-900 border-b border-r border-slate-700" />
              {txCols.map((col) => (
                <th
                  key={`${col.deviceIp}:${col.chId}`}
                  className="bg-slate-850 border-b border-r border-slate-700/60 px-1 py-1 text-slate-400 font-normal whitespace-nowrap max-w-[64px]"
                  style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 72 }}
                  title={`${col.deviceName} · ${col.chName}`}
                >
                  {col.chName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rxRows.map((row, rowIdx) => {
              const prevDevice = rowIdx > 0 ? rxRows[rowIdx - 1].deviceName : null;
              const isNewDevice = row.deviceName !== prevDevice;
              const statusColor = row.subscribed ? 'text-green-400'
                : row.statusText === 'Dangling' ? 'text-red-400'
                : 'text-slate-600';
              return (
                <React.Fragment key={`${row.deviceIp}:${row.chId}`}>
                  {isNewDevice && (
                    <tr className="bg-slate-800/60">
                      <td
                        colSpan={2 + txCols.length}
                        className="sticky left-0 px-2 py-0.5 text-[10px] font-semibold text-purple-400 border-t border-slate-700"
                      >
                        {row.deviceName}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td className="sticky left-0 z-10 bg-slate-900 border-b border-r border-slate-700/60 px-2 py-1 text-slate-300 whitespace-nowrap min-w-[120px] max-w-[180px] truncate">
                      {row.chName}
                    </td>
                    <td className={`sticky left-[120px] z-10 bg-slate-900 border-b border-r border-slate-700/60 px-2 py-1 whitespace-nowrap min-w-[80px] ${statusColor}`}>
                      {row.subscribed
                        ? `← ${row.txHost || '?'}.${row.txChannelName || '?'}`
                        : row.statusText === 'Unsubscribed' ? '—' : (row.statusText || '—')}
                    </td>
                    {txCols.map(col => {
                      const cellKey = `${row.deviceIp}:${row.chId}:${col.deviceName}:${col.chName}`;
                      const active  = activeSet.has(cellKey);
                      const loading = pendingCell === cellKey;
                      return (
                        <MatrixCell
                          key={`${col.deviceIp}:${col.chId}`}
                          active={active}
                          loading={loading}
                          cellKey={cellKey}
                          title={active
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
          </tbody>
        </table>
      </div>

      {/* Toast notification */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-xl text-sm font-medium transition-all ${
          toast.ok
            ? 'bg-green-900/90 text-green-200 border border-green-700'
            : 'bg-red-900/90 text-red-200 border border-red-700'
        }`}>
          {toast.ok
            ? <CheckCircle2 size={14} className="text-green-400" />
            : <AlertTriangle size={14} className="text-red-400" />
          }
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
