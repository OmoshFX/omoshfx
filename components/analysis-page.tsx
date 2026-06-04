'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';

type DigitResult = { digit: number; even: boolean; timestamp: number };
type Section = 'even-odd' | 'over-under' | 'matches';

const SYMBOLS = [
  { value: '1HZ100V', label: 'Volatility 100 (1s) Index' },
  { value: '1HZ75V',  label: 'Volatility 75 (1s) Index'  },
  { value: '1HZ50V',  label: 'Volatility 50 (1s) Index'  },
  { value: '1HZ25V',  label: 'Volatility 25 (1s) Index'  },
  { value: '1HZ10V',  label: 'Volatility 10 (1s) Index'  },
  { value: 'R_100',   label: 'Volatility 100 Index'       },
  { value: 'R_75',    label: 'Volatility 75 Index'        },
  { value: 'R_50',    label: 'Volatility 50 Index'        },
  { value: 'R_25',    label: 'Volatility 25 Index'        },
  { value: 'R_10',    label: 'Volatility 10 Index'        },
];

const DIGIT_OPTIONS = [0,1,2,3,4,5,6,7,8,9];
const HISTORY_SIZE = 50;

function useLiveTicks(symbol: string) {
  const [digits, setDigits]   = useState<DigitResult[]>([]);
  const [connected, setConn]  = useState(false);
  const pipRef = useRef(2);
  const wsRef  = useRef<WebSocket | null>(null);

  useEffect(() => {
    setDigits([]);
    setConn(false);
    const ws = new WebSocket(
      'wss://ws.derivws.com/websockets/v3?app_id=1089'
    );
    wsRef.current = ws;

    ws.onopen = () => {
      setConn(true);
      ws.send(JSON.stringify({
        ticks_history: symbol, count: HISTORY_SIZE,
        end: 'latest', style: 'ticks', subscribe: 1,
      }));
    };
    ws.onclose = () => setConn(false);
    ws.onerror = () => setConn(false);

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.msg_type === 'history') {
        const pip = msg.pip_size ?? 2;
        pipRef.current = pip;
        const factor = Math.pow(10, pip);
        const ps: number[] = msg.history?.prices ?? [];
        const ts: number[] = msg.history?.times  ?? [];
        setDigits(ps.map((p, i) => {
          const digit = Math.round(p * factor) % 10;
          return { digit, even: digit % 2 === 0, timestamp: ts[i] };
        }));
      }
      if (msg.msg_type === 'tick') {
        const pip    = msg.tick?.pip_size ?? pipRef.current;
        pipRef.current = pip;
        const factor = Math.pow(10, pip);
        const digit  = Math.round((msg.tick?.quote ?? 0) * factor) % 10;
        setDigits(prev =>
          [...prev, { digit, even: digit % 2 === 0, timestamp: msg.tick?.epoch ?? Date.now() }]
            .slice(-HISTORY_SIZE)
        );
      }
    };
    return () => { ws.close(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  return { digits, connected };
}

function pct(n: number, total: number) {
  return total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
}

function Bubble({ label, active }: { label: string; active: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, borderRadius: '50%', fontSize: 11, fontWeight: 600,
      flexShrink: 0,
      background: active ? '#ef4444' : '#22c55e',
      color: '#fff',
    }}>{label}</span>
  );
}

function Bar({ value, color, label }: { value: number; color: string; label: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
        <span>{label}</span>
        <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{value}%</span>
      </div>
      <div style={{ height: 10, borderRadius: 5, background: 'var(--color-background-tertiary)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${value}%`, background: color, borderRadius: 5, transition: 'width 0.4s ease' }} />
      </div>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--color-background-secondary)',
      borderRadius: 12, padding: '18px 20px', marginBottom: 16,
      border: '1px solid var(--color-border-tertiary)',
    }}>
      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 14, color: 'var(--color-text-primary)' }}>{title}</div>
      {children}
    </div>
  );
}

function DigitStatRow({ digit, count, total, selected, onSelect }: {
  digit: number; count: number; total: number; selected: boolean; onSelect: () => void;
}) {
  const p      = pct(count, total);
  const isHot  = p > 12;
  const isCold = p < 8;
  return (
    <div onClick={onSelect} style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px',
      borderRadius: 8, cursor: 'pointer', marginBottom: 4,
      background: selected ? 'var(--color-background-info)' : 'transparent',
      transition: 'background 0.2s',
    }}>
      <span style={{
        width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0,
        background: selected ? 'var(--color-text-info)' : 'var(--color-background-tertiary)',
        color: selected ? '#fff' : 'var(--color-text-primary)',
      }}>{digit}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ height: 8, borderRadius: 4, background: 'var(--color-background-tertiary)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${Math.min(p, 100)}%`,
            background: isHot ? '#ef4444' : isCold ? '#22c55e' : 'var(--color-text-secondary)',
            borderRadius: 4, transition: 'width 0.4s ease',
          }} />
        </div>
      </div>
      <span style={{
        fontSize: 12, fontWeight: 600, minWidth: 38, textAlign: 'right',
        color: isHot ? '#ef4444' : isCold ? '#22c55e' : 'var(--color-text-secondary)',
      }}>{p}%</span>
    </div>
  );
}

export function AnalysisPage() {
  const [symbol,   setSymbol]   = useState(SYMBOLS[0].value);
  const [section,  setSection]  = useState<Section>('even-odd');
  const [barrier,  setBarrier]  = useState(-1);
  const [matchDig, setMatchDig] = useState(-1);
  const { digits, connected }   = useLiveTicks(symbol);

  const total      = digits.length;
  const evenCount  = digits.filter(d => d.even).length;
  const oddCount   = total - evenCount;
  const evenPct    = pct(evenCount, total);
  const oddPct     = pct(oddCount,  total);

  const overCount  = digits.filter(d => d.digit > barrier).length;
  const underCount = digits.filter(d => d.digit < barrier).length;
  const equalCount = digits.filter(d => d.digit === barrier).length;
  const overPct    = pct(overCount,  total);
  const underPct   = pct(underCount, total);
  const equalPct   = pct(equalCount, total);

  const matchCount  = digits.filter(d => d.digit === matchDig).length;
  const differCount = total - matchCount;
  const matchPct    = pct(matchCount,  total);
  const differPct   = pct(differCount, total);

  const digitCounts = Array.from({ length: 10 }, (_, i) => ({
    digit: i,
    count: digits.filter(d => d.digit === i).length,
  }));

  const tabs: { key: Section; label: string }[] = [
    { key: 'even-odd',   label: 'Even / Odd'       },
    { key: 'over-under', label: 'Over / Under'      },
    { key: 'matches',    label: 'Matches / Differs' },
  ];

  const appName = process.env.NEXT_PUBLIC_DERIV_APP_NAME ?? 'OmoshFX';

  return (
    <>
      {/* ── Top navigation bar (matches main app style) ── */}
      <header style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 16px', height: 56,
        borderBottom: '1px solid var(--color-border-tertiary)',
        background: 'var(--color-background-primary)',
        backdropFilter: 'blur(8px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Logo / app name */}
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
            <div style={{
              width: 32, height: 32, borderRadius: 6,
              background: 'var(--color-background-tertiary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 700, fontSize: 13, color: 'var(--color-text-primary)',
            }}>
              {appName.charAt(0).toUpperCase()}
            </div>
            <span style={{ fontWeight: 600, fontSize: 16, color: 'var(--color-text-primary)' }}>
              {appName}
            </span>
          </Link>
          {/* Nav links */}
          <nav style={{ display: 'flex', gap: 4 }}>
<Link href="/" style={{
    padding: '4px 12px', borderRadius: 20, fontSize: 13, textDecoration: 'none',
    color: 'var(--color-text-secondary)',
  }}>Trade</Link>
  <span style={{
    padding: '4px 12px', borderRadius: 20, fontSize: 13,
    background: 'var(--color-background-tertiary)',
    color: 'var(--color-text-primary)', fontWeight: 500,
  }}>Analysis</span>
  <Link href="/bot" style={{
    padding: '4px 12px', borderRadius: 20, fontSize: 13, textDecoration: 'none',
    color: 'var(--color-text-secondary)',
  }}>Bot</Link>
</nav>
        </div>
        {/* Live indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: connected ? '#22c55e' : '#ef4444',
            display: 'inline-block',
          }} />
          {connected ? 'Live' : 'Connecting…'}
        </div>
      </header>

      {/* ── Page body ── */}
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '72px 16px 32px', fontFamily: 'var(--font-sans)' }}>

        {/* Title + symbol selector */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: 'var(--color-text-primary)' }}>Analysis Tool</h2>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>
              Live digit statistics · last {total} ticks
            </p>
          </div>
          <select
            value={symbol}
            onChange={e => setSymbol(e.target.value)}
            style={{
              padding: '8px 12px', borderRadius: 8, fontSize: 13,
              border: '1px solid var(--color-border-secondary)',
              background: 'var(--color-background-secondary)',
              color: 'var(--color-text-primary)', cursor: 'pointer',
            }}
          >
            {SYMBOLS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>

        {/* Section tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setSection(t.key)}
              style={{
                padding: '8px 16px', borderRadius: 20, fontSize: 13, fontWeight: 500,
                border: '1px solid var(--color-border-secondary)', cursor: 'pointer',
                background: section === t.key ? 'var(--color-text-primary)' : 'var(--color-background-secondary)',
                color:      section === t.key ? 'var(--color-background-primary)' : 'var(--color-text-secondary)',
                transition: 'all 0.2s',
              }}
            >{t.label}</button>
          ))}
        </div>

        {/* Recent bubbles + bars */}
        <SectionCard title={
          section === 'even-odd'   ? 'Recent E / O' :
          section === 'over-under' ? `Recent vs barrier ${barrier}` :
          `Recent digits vs ${matchDig}`
        }>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 16 }}>
            {digits.slice(-40).map((d, i) => {
              let active = false;
              if (section === 'even-odd')   active = !d.even;
              if (section === 'over-under') active = d.digit < barrier;
              if (section === 'matches')    active = d.digit !== matchDig;
              const label =
                section === 'even-odd'   ? (d.even ? 'E' : 'O') :
                section === 'over-under' ? (d.digit > barrier ? 'O' : d.digit < barrier ? 'U' : '=') :
                String(d.digit);
              return <Bubble key={i} label={label} active={active} />;
            })}
            {total === 0 && <span style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>Connecting…</span>}
          </div>

          {section === 'even-odd' && (
            <div style={{ display: 'flex', gap: 16 }}>
              <Bar value={evenPct} color="#22c55e" label="Even" />
              <Bar value={oddPct}  color="#ef4444" label="Odd"  />
            </div>
          )}
          {section === 'over-under' && (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Bar value={underPct} color="#22c55e" label="Under" />
              <Bar value={equalPct} color="#6b7280" label="Equal" />
              <Bar value={overPct}  color="#ef4444" label="Over"  />
            </div>
          )}
          {section === 'matches' && (
            <div style={{ display: 'flex', gap: 16 }}>
              <Bar value={matchPct}  color="#22c55e" label={`Matches ${matchDig}`} />
              <Bar value={differPct} color="#ef4444" label="Differs"               />
            </div>
          )}
        </SectionCard>

        {/* Digit / barrier picker */}
        {section === 'over-under' && (
          <SectionCard title="Select barrier">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {DIGIT_OPTIONS.map(b => (
                <button key={b} onClick={() => setBarrier(b)} style={{
                  width: 40, height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14,
                  border: `1px solid ${barrier === b ? 'var(--color-text-info)' : 'var(--color-border-secondary)'}`,
                  background: barrier === b ? 'var(--color-background-info)' : 'var(--color-background-secondary)',
                  color: barrier === b ? 'var(--color-text-info)' : 'var(--color-text-primary)',
                  cursor: 'pointer', transition: 'all 0.15s',
                }}>{b}</button>
              ))}
            </div>
            <div style={{ marginTop: 14, fontSize: 13, color: 'var(--color-text-secondary)' }}>
              Under <b style={{ color: 'var(--color-text-primary)' }}>{barrier}</b>: {underPct}% &nbsp;|&nbsp;
              Equal: {equalPct}% &nbsp;|&nbsp;
              Over <b style={{ color: 'var(--color-text-primary)' }}>{barrier}</b>: {overPct}%
            </div>
          </SectionCard>
        )}

        {section === 'matches' && (
          <SectionCard title="Select digit to match">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {DIGIT_OPTIONS.map(b => (
                <button key={b} onClick={() => setMatchDig(b)} style={{
                  width: 40, height: 40, borderRadius: 8, fontWeight: 600, fontSize: 14,
                  border: `1px solid ${matchDig === b ? 'var(--color-text-info)' : 'var(--color-border-secondary)'}`,
                  background: matchDig === b ? 'var(--color-background-info)' : 'var(--color-background-secondary)',
                  color: matchDig === b ? 'var(--color-text-info)' : 'var(--color-text-primary)',
                  cursor: 'pointer', transition: 'all 0.15s',
                }}>{b}</button>
              ))}
            </div>
            <div style={{ marginTop: 14, fontSize: 13, color: 'var(--color-text-secondary)' }}>
              Matches <b style={{ color: 'var(--color-text-primary)' }}>{matchDig}</b>: {matchPct}% &nbsp;|&nbsp;
              Differs: {differPct}%
            </div>
          </SectionCard>
        )}

        {/* Digit frequency — all 10 digits shown with correct labels */}
        <SectionCard title="Digit frequency (last 50 ticks)">
          {digitCounts.map(({ digit, count }) => (
            <DigitStatRow
              key={digit}
              digit={digit}
              count={count}
              total={total}
              selected={section === 'over-under' ? digit === barrier : digit === matchDig}
              onSelect={() => section === 'over-under' ? setBarrier(digit) : setMatchDig(digit)}
            />
          ))}
        </SectionCard>
      </div>
    </>
  );
}
