/**
 * dsh-conv-progress — web client half.
 *
 * v3: the capsule is now **always visible** in `conversation.composer.dock`
 * (the ambient strip below the composer card):
 *   · a running turn renders the live estimate (unchanged);
 *   · no running turn renders "100%" (idle) — and, during the 6s linger window
 *     right after a turn ends, the finished-turn summary (unchanged contract);
 *   · clicking the capsule opens a scrollable list of this session's finished
 *     turns (time, duration, task text, steps, tools, plan delta, reason,
 *     confidence), read through the new `convProgress/history` Remote.
 *
 * Everything math-related still lives on the host (`convProgress/snapshot`).
 * This file polls, formats, paints, and owns the popover.
 *
 * Loaded by the harness' module loader — the wrapper below is mandatory (a bare
 * `export` makes the merged plugin bundle throw `Unexpected token 'export'`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-conv-progress',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = 'convProgress';
    /** Poll cadence: fast while a turn runs, lazy when idle. */
    const POLL_RUNNING_MS = 900;
    const POLL_IDLE_MS = 4000;
    /** Keep the finished capsule summary visible this long, then turn idle. */
    const DONE_LINGER_MS = 6000;
    /** While the history popover is open, refresh it at this cadence. */
    const HISTORY_POLL_MS = 3000;

    let connection = null;

    const zh = {
      label: '进度',
      eta: '剩余约 {t}',
      etaRough: '剩余 ≈ {t}',
      elapsed: '已用 {t}',
      steps: '{done}/{total} 步',
      step: '第 {n} 步',
      preparing: '准备中',
      thinking: '思考中',
      tool: '调用 {name}',
      working: '处理中',
      idle: '空闲',
      done: '本轮完成 · {steps} 步 · {elapsed}',
      doneShort: '本轮完成',
      plan: '计划 {done}/{total}',
      lowConfidence: '估算',
      unavailable: '进度估算不可用',
      turnsCount: '{n} 条记录',
      openHint: '点击查看历史任务',

      historyTitle: '历史任务记录',
      historyTotal: '共 {n} 条',
      historyLoading: '正在加载…',
      historyError: '历史记录加载失败，稍后自动重试',
      historyEmpty: '本次会话还没有已完成的任务记录',
      historyEmptyHint: '任务结束后会出现在这里；进行中的任务显示在上方胶囊中。',
      justNow: '刚刚',
      minutesAgo: '{n} 分钟前',
      hoursAgo: '{n} 小时前',
      daysAgo: '{n} 天前',
      recTurn: '第 {n} 轮',
      recDuration: '耗时 {t}',
      recSteps: '{n} 步',
      recTools: '工具 {n} 次',
      recPlan: '完成 {n} 项计划',
      recConfidence: '置信 {level}',
      recUntitled: '（无文本任务描述）',
      confidence: { low: '低', medium: '中', high: '高' },
      reason: {
        completed: '完成',
        aborted: '中止',
        interrupted: '中断',
        error: '出错',
        blocked: '阻止',
        'max-tokens': '超长',
        forked: '分叉',
        unknown: '结束',
      },
      close: '关闭',
    };
    const en = {
      label: 'Progress',
      eta: '~{t} left',
      etaRough: '≈{t} left',
      elapsed: '{t} elapsed',
      steps: '{done}/{total} steps',
      step: 'step {n}',
      preparing: 'preparing',
      thinking: 'reasoning',
      tool: 'calling {name}',
      working: 'working',
      idle: 'idle',
      done: 'Turn finished · {steps} steps · {elapsed}',
      doneShort: 'finished',
      plan: 'plan {done}/{total}',
      lowConfidence: 'estimate',
      unavailable: 'progress estimate unavailable',
      turnsCount: '{n} records',
      openHint: 'Click to view past tasks',

      historyTitle: 'Task history',
      historyTotal: '{n} total',
      historyLoading: 'Loading…',
      historyError: 'Could not load history — retrying shortly',
      historyEmpty: 'No finished turns in this session yet',
      historyEmptyHint: 'Finished turns show up here; the running one stays in the capsule.',
      justNow: 'just now',
      minutesAgo: '{n}m ago',
      hoursAgo: '{n}h ago',
      daysAgo: '{n}d ago',
      recTurn: 'Turn {n}',
      recDuration: '{t}',
      recSteps: '{n} steps',
      recTools: '{n} tool calls',
      recPlan: '{n} plan items',
      recConfidence: 'confidence {level}',
      recUntitled: '(no text task description)',
      confidence: { low: 'low', medium: 'med', high: 'high' },
      reason: {
        completed: 'done',
        aborted: 'aborted',
        interrupted: 'interrupted',
        error: 'error',
        blocked: 'blocked',
        'max-tokens': 'max tokens',
        forked: 'forked',
        unknown: 'ended',
      },
      close: 'Close',
    };

    const DICTS = { zh, en };

    // ── tiny helpers (no dependency on a shared util bundle) ────────────────
    function pickDict() {
      try {
        const lang = (document.documentElement.getAttribute('lang') || navigator.language || 'zh').toLowerCase();
        return lang.startsWith('zh') ? zh : en;
      } catch {
        return zh;
      }
    }

    function fmt(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (vars?.[key] === undefined ? match : String(vars[key])));
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—';
      const total = Math.round(ms / 1000);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
      if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
      return `${seconds}s`;
    }

    function clamp01(value) {
      if (!Number.isFinite(value)) return 0;
      return value < 0 ? 0 : value > 1 ? 1 : value;
    }

    /** "14:32" for record rows. */
    function formatClock(timestamp) {
      if (!Number.isFinite(timestamp)) return '';
      try {
        const date = new Date(timestamp);
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      } catch {
        return '';
      }
    }

    function formatRelative(timestamp, now, t) {
      if (!Number.isFinite(timestamp)) return '';
      const diff = Math.max(0, now - timestamp);
      const minutes = Math.floor(diff / 60000);
      if (minutes < 1) return t.justNow;
      if (minutes < 60) return fmt(t.minutesAgo, { n: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return fmt(t.hoursAgo, { n: hours });
      return fmt(t.daysAgo, { n: Math.floor(hours / 24) });
    }

    // ── styles ──────────────────────────────────────────────────────────────
    // The composer dock is a centered flex row of small pills (official ones
    // use `--dsw-alias-label-tertiary`, radius-sm, tabular-nums). We match that
    // vocabulary and give the row a fixed, deliberately short bar.
    // v3 adds: button reset, idle/open states, and the history popover.
    const CSS = `
.cvp-wrap {
  position: relative; display: inline-flex; align-items: center; max-width: 100%;
}
.cvp-caps {
  display: inline-flex; align-items: center; gap: 8px;
  box-sizing: border-box; max-width: 100%; height: 22px;
  padding: 0 10px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, rgb(127,127,127)) 10%, transparent);
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, rgba(127,127,127,.92)));
  font: inherit; font-size: 11.5px; line-height: 16px; font-variant-numeric: tabular-nums;
  white-space: nowrap; user-select: none; cursor: pointer; appearance: none;
  backdrop-filter: blur(6px);
  transition: border-color 160ms ease, background-color 160ms ease;
}
.cvp-caps:hover {
  border-color: var(--dsw-alias-border-l2, rgba(127,127,127,.35));
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, rgb(127,127,127)) 14%, transparent);
}
.cvp-caps:focus-visible {
  outline: 2px solid var(--dsw-alias-state-success-primary, #22c55e);
  outline-offset: 2px;
}
.cvp-caps[data-open="1"] {
  border-color: var(--dsw-alias-border-l2, rgba(127,127,127,.35));
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, rgb(127,127,127)) 16%, transparent);
}
.cvp-dot {
  flex: none; width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-success-primary, #22c55e);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 22%, transparent);
}
.cvp-phase {
  flex: 0 1 auto; min-width: 0; max-width: 96px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, rgba(127,127,127,.92));
  font-weight: 500;
}
.cvp-bar {
  position: relative; flex: none; width: 150px; height: 3px;
  border-radius: 999px; overflow: hidden;
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, rgb(127,127,127)) 16%, transparent);
}
.cvp-fill {
  position: absolute; inset: 0 auto 0 0; border-radius: inherit;
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 62%, transparent),
    var(--dsw-alias-state-success-primary, #22c55e));
  box-shadow: 0 0 6px -1px color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 55%, transparent);
  transition: width 380ms cubic-bezier(.22,.61,.36,1);
}
.cvp-fill[data-unknown="1"] {
  background: repeating-linear-gradient(90deg,
    color-mix(in srgb, var(--dsw-alias-label-tertiary, rgb(127,127,127)) 46%, transparent) 0 6px,
    transparent 6px 12px);
  box-shadow: none;
  opacity: .8;
}
.cvp-pct {
  flex: none; min-width: 30px; text-align: right;
  color: var(--dsw-alias-label-primary, currentColor);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px; font-weight: 600; letter-spacing: -.2px;
}
.cvp-eta { flex: none; opacity: .88; }
.cvp-eta[data-rough="1"] { opacity: .66; font-style: italic; }
.cvp-count { flex: none; opacity: .72; font-size: 11px; }
.cvp-done .cvp-phase { color: var(--dsw-alias-label-secondary, currentColor); font-weight: 400; }
.cvp-idle .cvp-dot {
  background: var(--dsw-alias-state-idle-primary, rgb(127,127,127));
  box-shadow: none; opacity: .9;
}
.cvp-idle .cvp-phase { color: var(--dsw-alias-label-tertiary, currentColor); font-weight: 400; }
.cvp-low .cvp-dot {
  background: var(--dsw-alias-state-idle-primary, rgb(127,127,127));
  box-shadow: none;
}
.cvp-low .cvp-pct { display: none; }
.cvp-low .cvp-phase { color: var(--dsw-alias-label-tertiary, currentColor); font-weight: 400; }
@media (prefers-reduced-motion: no-preference) {
  .cvp-caps[data-running="1"] .cvp-dot { animation: cvp-breathe 2.4s ease-in-out infinite; }
}
@keyframes cvp-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: .45; }
}
@media (prefers-reduced-motion: reduce) {
  .cvp-fill { transition: none; }
  .cvp-caps { transition: none; }
}
@media (max-width: 760px) {
  .cvp-caps { max-width: 240px; padding: 0 8px; gap: 6px; }
  .cvp-bar { width: 104px; }
  .cvp-eta { display: none; }
}

/* ── history popover (opens upward, fixed-positioned above the capsule) ── */
.cvp-pop {
  position: fixed; z-index: 60;
  display: flex; flex-direction: column; overflow: hidden;
  box-sizing: border-box; max-height: min(46vh, 360px);
  border-radius: var(--dsw-radius-lg, 12px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
  background: var(--dsw-alias-bg-layer-2, #232529);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.45));
  color: var(--dsw-alias-label-secondary, rgb(207,211,214));
  font-size: 11.5px; line-height: 1.5;
  animation: cvp-pop-in 140ms ease-out;
}
@keyframes cvp-pop-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .cvp-pop { animation: none; } }
.cvp-pop-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 8px 12px; flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18));
}
.cvp-pop-title {
  font-size: 11.5px; font-weight: 600; letter-spacing: .02em;
  color: var(--dsw-alias-label-secondary, rgb(207,211,214));
}
.cvp-pop-count {
  font-size: 11px; color: var(--dsw-alias-label-tertiary, rgb(173,178,184));
  font-variant-numeric: tabular-nums;
}
.cvp-pop-body {
  overflow-y: auto; overscroll-behavior: contain; padding: 4px;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-border-l2, rgba(180,180,180,.35)) transparent;
}
.cvp-pop-body::-webkit-scrollbar { width: 8px; height: 8px; }
.cvp-pop-body::-webkit-scrollbar-thumb {
  border-radius: 999px; background: var(--dsw-alias-border-l2, rgba(180,180,180,.35));
}
.cvp-pop-body::-webkit-scrollbar-track { background: transparent; }
.cvp-pop-hint {
  padding: 16px 12px; text-align: center; color: var(--dsw-alias-label-tertiary, rgb(173,178,184));
}
.cvp-pop-hint-sub { display: block; margin-top: 4px; font-size: 11px; opacity: .8; }
.cvp-rec {
  display: flex; flex-direction: column; gap: 3px;
  padding: 7px 8px; border-radius: var(--dsw-radius-sm, 8px);
}
.cvp-rec + .cvp-rec { box-shadow: inset 0 1px 0 var(--dsw-alias-border-l1, rgba(127,127,127,.14)); }
.cvp-rec:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }
.cvp-rec-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cvp-rec-turn {
  flex: none; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10.5px; font-weight: 600; color: var(--dsw-alias-label-tertiary, rgb(173,178,184));
}
.cvp-chip {
  flex: none; font-size: 10px; line-height: 15px; padding: 0 6px; border-radius: 999px;
  border: 1px solid currentColor; opacity: .9; white-space: nowrap;
}
.cvp-chip-completed { color: var(--dsw-alias-state-success-primary, #22c55e); }
.cvp-chip-error { color: var(--dsw-alias-state-error-primary, #f25a5a); }
.cvp-chip-warn { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.cvp-chip-idle { color: var(--dsw-alias-label-tertiary, rgb(173,178,184)); }
.cvp-rec-time {
  margin-left: auto; flex: none; font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgb(173,178,184));
  font-variant-numeric: tabular-nums;
}
.cvp-rec-title {
  font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-primary, rgb(249,250,251));
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.cvp-rec-meta {
  display: flex; flex-wrap: wrap; gap: 4px 10px;
  font-size: 11px; color: var(--dsw-alias-label-tertiary, rgb(173,178,184));
  font-variant-numeric: tabular-nums;
}
`;

    function injectStyles() {
      const style = document.createElement('style');
      style.dataset.convProgress = '1';
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => {
        try {
          style.remove();
        } catch {
          /* already gone */
        }
      };
    }

    // ── snapshot polling (UNCHANGED since v1) ───────────────────────────────
    function useSnapshot(sessionId) {
      const [snapshot, setSnapshot] = useState(null);
      const runningRef = useRef(false);

      useEffect(() => {
        if (!sessionId || connection === null) return undefined;
        let alive = true;
        let timer = null;
        let failures = 0;

        const schedule = () => {
          if (!alive) return;
          const delay = runningRef.current ? POLL_RUNNING_MS : POLL_IDLE_MS;
          timer = setTimeout(tick, delay);
        };

        const tick = async () => {
          try {
            const result = await connection.rpc.call('/api', 'convProgress/snapshot', {
              args: { request: { sessionId } },
            });
            if (!alive) return;
            if (result?.ok === true && result.value !== undefined) {
              failures = 0;
              runningRef.current = result.value.running === true;
              setSnapshot(result.value);
            } else {
              failures += 1;
            }
          } catch {
            failures += 1;
            if (failures === 1) console.debug('[conv-progress] snapshot unavailable');
          }
          schedule();
        };

        tick();
        return () => {
          alive = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, [sessionId]);

      return snapshot;
    }

    // ── history polling (only while the popover is open) ────────────────────
    function useHistory(sessionId, open, revision) {
      const [state, setState] = useState({ status: 'idle', records: [], total: 0 });
      useEffect(() => {
        if (!open || !sessionId || connection === null) return undefined;
        let alive = true;
        let timer = null;

        const load = async () => {
          try {
            const result = await connection.rpc.call('/api', 'convProgress/history', {
              args: { request: { sessionId } },
            });
            if (!alive) return;
            if (result?.ok === true && result.value !== undefined) {
              setState({
                status: 'ready',
                records: Array.isArray(result.value.records) ? result.value.records : [],
                total: Number.isFinite(result.value.total) ? result.value.total : 0,
              });
            } else {
              setState((prev) => (prev.status === 'ready' ? prev : { ...prev, status: 'error' }));
            }
          } catch {
            if (alive) setState((prev) => (prev.status === 'ready' ? prev : { ...prev, status: 'error' }));
          }
          if (alive) timer = setTimeout(load, HISTORY_POLL_MS);
        };

        setState((prev) => (prev.status === 'ready' ? prev : { ...prev, status: 'loading' }));
        load();
        return () => {
          alive = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, [open, sessionId, revision]);
      return state;
    }

    // ── history popover ─────────────────────────────────────────────────────
    const REASON_TONES = {
      completed: 'completed',
      error: 'error',
      aborted: 'warn',
      interrupted: 'warn',
      blocked: 'warn',
      'max-tokens': 'warn',
      forked: 'idle',
      unknown: 'idle',
    };

    function HistoryPanel({ anchor, sessionId, state, t }) {
      const now = Date.now();
      const style = anchor === null
        ? { visibility: 'hidden' }
        : { left: `${anchor.left}px`, bottom: `${anchor.bottom}px`, width: `${anchor.width}px` };

      let body;
      if (state.records.length === 0) {
        if (state.status === 'loading' || state.status === 'idle') {
          body = h('div', { key: 'loading', className: 'cvp-pop-hint' }, t.historyLoading);
        } else if (state.status === 'error') {
          body = h('div', { key: 'error', className: 'cvp-pop-hint' }, t.historyError);
        } else {
          body = h('div', { key: 'empty', className: 'cvp-pop-hint' }, [
            h('span', { key: 'text' }, t.historyEmpty),
            h('span', { key: 'sub', className: 'cvp-pop-hint-sub' }, t.historyEmptyHint),
          ]);
        }
      } else {
        body = state.records.map((record) => {
          const reason = typeof record.reason === 'string' ? record.reason : 'unknown';
          const tone = REASON_TONES[reason] ?? 'idle';
          const reasonLabel = t.reason[reason] ?? reason;
          const confidence = ['low', 'medium', 'high'].includes(record.confidence) ? record.confidence : 'low';
          const endedAt = Number.isFinite(record.endedAt) ? record.endedAt : null;
          const when = endedAt === null ? '' : `${formatClock(endedAt)} · ${formatRelative(endedAt, now, t)}`;
          return h('div', { key: `turn-${record.turn}`, className: 'cvp-rec' }, [
            h('div', { key: 'top', className: 'cvp-rec-top' }, [
              h('span', { key: 'turn', className: 'cvp-rec-turn' }, fmt(t.recTurn, { n: record.turn })),
              h('span', { key: 'chip', className: `cvp-chip cvp-chip-${tone}` }, reasonLabel),
              h('span', { key: 'time', className: 'cvp-rec-time' }, when),
            ]),
            h('div', { key: 'title', className: 'cvp-rec-title', title: record.title || '' },
              record.title && record.title.length > 0 ? record.title : t.recUntitled),
            h('div', { key: 'meta', className: 'cvp-rec-meta' }, [
              h('span', { key: 'duration' }, fmt(t.recDuration, { t: formatDuration(record.durationMs) })),
              h('span', { key: 'steps' }, fmt(t.recSteps, { n: record.steps ?? 0 })),
              h('span', { key: 'tools' }, fmt(t.recTools, { n: record.tools ?? 0 })),
              record.todoDelta > 0 ? h('span', { key: 'plan' }, fmt(t.recPlan, { n: record.todoDelta })) : null,
              h('span', { key: 'confidence' }, fmt(t.recConfidence, { level: t.confidence[confidence] })),
            ]),
          ]);
        });
      }

      return h('div', {
        className: 'cvp-pop',
        role: 'dialog',
        'aria-modal': 'false',
        'aria-label': t.historyTitle,
        'data-session': sessionId ?? '',
        style,
      }, [
        h('div', { key: 'head', className: 'cvp-pop-head' }, [
          h('span', { key: 'title', className: 'cvp-pop-title' }, t.historyTitle),
          h('span', { key: 'count', className: 'cvp-pop-count' },
            fmt(t.historyTotal, { n: state.records.length === 0 ? state.total : state.records.length })),
        ]),
        h('div', { key: 'body', className: 'cvp-pop-body' }, body),
      ]);
    }

    // ── the capsule ─────────────────────────────────────────────────────────
    function ConvProgressDock(props) {
      // `conversation.composer.dock` is a session-scoped slot; some harness
      // versions pass `sessionId` directly, others hand over the session object.
      const sessionId = props.sessionId ?? props.session?.sessionId ?? null;
      const t = pickDict();
      const snapshot = useSnapshot(sessionId);
      const [linger, setLinger] = useState(null);
      const prevRunning = useRef(false);
      const [open, setOpen] = useState(false);
      const wrapRef = useRef(null);
      const [anchor, setAnchor] = useState(null);

      // UNCHANGED: when a turn ends, keep a "finished" summary up briefly.
      useEffect(() => {
        if (snapshot === null) return undefined;
        const running = snapshot.running === true;
        if (prevRunning.current && !running && snapshot.turn > 0) {
          setLinger({ steps: snapshot.stepsDone, elapsedMs: snapshot.elapsedMs, at: Date.now() });
          const handle = setTimeout(() => setLinger(null), DONE_LINGER_MS);
          prevRunning.current = running;
          return () => clearTimeout(handle);
        }
        prevRunning.current = running;
        return undefined;
      }, [snapshot]);

      // A different session gets a fresh popover.
      useEffect(() => {
        setOpen(false);
      }, [sessionId]);

      // Keep the fixed-position panel glued to the capsule while open.
      useEffect(() => {
        if (!open) {
          setAnchor(null);
          return undefined;
        }
        const compute = () => {
          const node = wrapRef.current;
          if (node === null) return;
          const rect = node.getBoundingClientRect();
          const width = Math.round(Math.min(520, Math.max(300, window.innerWidth - 24)));
          const center = rect.left + rect.width / 2;
          const left = Math.min(Math.max(center, width / 2 + 8), window.innerWidth - width / 2 - 8);
          setAnchor({ left, bottom: Math.max(12, window.innerHeight - rect.top + 8), width });
        };
        compute();
        window.addEventListener('resize', compute);
        window.addEventListener('scroll', compute, true);
        return () => {
          window.removeEventListener('resize', compute);
          window.removeEventListener('scroll', compute, true);
        };
      }, [open]);

      // Close on Escape or a click outside the capsule + panel.
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        const onDown = (event) => {
          const node = wrapRef.current;
          if (node !== null && event.target instanceof Node && !node.contains(event.target)) setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown, true);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('mousedown', onDown, true);
        };
      }, [open]);

      const history = useHistory(sessionId, open, snapshot === null ? 0 : snapshot.turns ?? 0);

      // ── v3: never hide; idle means 100% ───────────────────────────────────
      const running = snapshot !== null && snapshot.running === true;
      const available = snapshot !== null && snapshot.available !== false;
      const percent = running ? clamp01(snapshot.percent) : 1;
      const lowConfidence = running && snapshot.confidence === 'low';
      const done = !running && available && (snapshot?.turn ?? 0) > 0 && percent >= 0.999;
      const showLinger = done && linger !== null;
      const idle = !running && !showLinger;
      const turns = Number.isFinite(snapshot?.turns) ? snapshot.turns : 0;

      const stepsTotal = Number.isFinite(snapshot?.expectedSteps) ? snapshot.expectedSteps : 0;
      const stepsDone = Number.isFinite(snapshot?.stepsDone) ? snapshot.stepsDone : 0;

      let phaseText;
      if (running) {
        if (snapshot.phase === 'preparing') phaseText = t.preparing;
        else if (snapshot.phase === 'tool') {
          const toolName = typeof snapshot.lastTool === 'string' && snapshot.lastTool.length > 0 ? snapshot.lastTool : '';
          phaseText = toolName.length > 0 ? fmt(t.tool, { name: toolName }) : t.working;
        } else if (snapshot.phase === 'thinking') phaseText = t.thinking;
        else phaseText = t.working;
      } else if (showLinger) {
        phaseText = t.doneShort;
      } else {
        phaseText = t.idle;
      }

      // UNCHANGED contract: low confidence shows elapsed only, no ETA.
      const etaText = running && !lowConfidence && Number.isFinite(snapshot.etaMs) && snapshot.etaMs > 0
        ? fmt(snapshot.confidence === 'low' ? t.etaRough : t.eta, { t: formatDuration(snapshot.etaMs) })
        : null;
      const elapsedMs = linger?.elapsedMs ?? snapshot?.elapsedMs ?? 0;
      const elapsedText = (lowConfidence || showLinger) && elapsedMs > 0
        ? fmt(t.elapsed, { t: formatDuration(elapsedMs) })
        : null;
      const idleCountText = idle && turns > 0 ? fmt(t.turnsCount, { n: turns }) : null;

      const pctText = running ? `${Math.floor(percent * 100)}%` : '100%';
      const unknownFill = running && (percent <= 0 || lowConfidence);

      const titleParts = [phaseText];
      if (running && !lowConfidence) titleParts.push(pctText);
      if (etaText !== null) titleParts.push(etaText);
      if (elapsedText !== null) titleParts.push(elapsedText);
      if (running && stepsDone > 0) titleParts.push(fmt(t.steps, { done: stepsDone, total: Math.max(stepsTotal, stepsDone) }));
      if (showLinger) titleParts.push(fmt(t.done, { steps: linger?.steps ?? stepsDone, elapsed: formatDuration(elapsedMs) }));
      if (idleCountText !== null) titleParts.push(idleCountText);
      titleParts.push(t.openHint);
      const titleText = titleParts.join(' · ');
      const ariaLabel = `${t.label} ${pctText}${phaseText.length > 0 ? ' · ' + phaseText : ''}`;

      return h('span', { className: 'cvp-wrap', ref: wrapRef }, [
        h('button', {
          key: 'caps',
          type: 'button',
          className: `cvp-caps${showLinger ? ' cvp-done' : ''}${lowConfidence ? ' cvp-low' : ''}${idle ? ' cvp-idle' : ''}`,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': titleText,
          'data-running': running ? '1' : '0',
          'data-open': open ? '1' : '0',
          'data-idle': idle ? '1' : '0',
          title: titleText,
          onClick: () => setOpen((value) => !value),
        }, [
          h('span', { key: 'dot', className: 'cvp-dot', 'aria-hidden': 'true' }),
          h('span', { key: 'phase', className: 'cvp-phase' }, phaseText),
          h('span', {
            key: 'bar',
            className: 'cvp-bar',
            role: 'progressbar',
            'aria-label': ariaLabel,
            'aria-valuenow': lowConfidence ? undefined : Math.round(percent * 100),
            'aria-valuemin': 0,
            'aria-valuemax': 100,
          }, h('span', {
            className: 'cvp-fill',
            'data-unknown': unknownFill ? '1' : '0',
            style: { width: unknownFill ? '100%' : `${Math.max(percent * 100, percent > 0 ? 3 : 0)}%` },
          })),
          lowConfidence ? null : h('span', { key: 'pct', className: 'cvp-pct' }, pctText),
          etaText !== null
            ? h('span', { key: 'eta', className: 'cvp-eta' }, etaText)
            : (elapsedText !== null
              ? h('span', { key: 'elapsed', className: 'cvp-eta' }, elapsedText)
              : (idleCountText !== null ? h('span', { key: 'count', className: 'cvp-count' }, idleCountText) : null)),
        ]),
        open
          ? h(HistoryPanel, { key: 'pop', anchor, sessionId, state: history, t })
          : null,
      ]);
    }

    // ── plugin entry (UNCHANGED registration) ───────────────────────────────
    function apply(ctx) {
      connection = ctx.connection ?? null;
      ctx.effect(() => injectStyles(), 'dsh-conv-progress: styles');
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-conv-progress: dictionaries');
      // v2: moved from `conversation.input.dock` (above the composer) to
      // `conversation.composer.dock` (ambient strip below it). `order: -1`
      // places us left of the official "activity" (0) and "usage" (1) pills.
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register({ name: 'conversation.composer.dock', id: 'conv-progress', order: -1, locale: NS }, ConvProgressDock),
      );
    }

    const inject = ['sessions', 'slots', 'locale', 'connection'];

    exports.apply = apply;
    exports.inject = inject;
    exports.ConvProgressDock = ConvProgressDock;
    return module.exports;
  },
});
