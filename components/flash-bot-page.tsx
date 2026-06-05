'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import { getAuthInfo } from '@deriv/core';

// ── Types ──────────────────────────────────────────────────────────────────────
type BotStatus = 'idle' | 'connecting' | 'running' | 'stopped';
type BotMode   = 'EVEN_ODD' | 'OVER_UNDER';

interface TradeLogEntry {
  id: string;
  time: string;
  type: 'info' | 'win' | 'loss' | 'error';
  text: string;
}

interface DigitEntry { digit: number; isEven: boolean; }

interface BotConfig {
  symbol: string;
  mode: BotMode;
  barrier: number;
  stake: number;
  takeProfit: number;
  stopLoss: number;
}

const SYMBOLS = [
  { value: 'R_100',   label: 'Volatility 100'      },
  { value: 'R_75',    label: 'Volatility 75'        },
  { value: 'R_50',    label: 'Volatility 50'        },
  { value: 'R_25',    label: 'Volatility 25'        },
  { value: 'R_10',    label: 'Volatility 10'        },
  { value: '1HZ100V', label: 'Volatility 100 (1s)'  },
  { value: '1HZ75V',  label: 'Volatility 75 (1s)'   },
  { value: '1HZ50V',  label: 'Volatility 50 (1s)'   },
  { value: '1HZ10V',  label: 'Volatility 10 (1s)'   },
];

const DERIV_WS = 'wss://ws.derivws.com/websockets/v3?app_id=1089';

// ── Bot Hook ───────────────────────────────────────────────────────────────────
function useFlashBot() {
  const [status,        setStatus]        = useState<BotStatus>('idle');
  const [balance,       setBalance]       = useState<number | null>(null);
  const [currency,      setCurrency]      = useState('USD');
  const [totalProfit,   setTotalProfit]   = useState(0);
  const [tradeCount,    setTradeCount]    = useState(0);
  const [wins,          setWins]          = useState(0);
  const [lastDigit,     setLastDigit]     = useState<number | null>(null);
  const [lastQuote,     setLastQuote]     = useState('');
  const [digitHistory,  setDigitHistory]  = useState<DigitEntry[]>([]);
  const [logs,          setLogs]          = useState<TradeLogEntry[]>([]);
  const [activeTrade,   setActiveTrade]   = useState('');

  const wsRef      = useRef<WebSocket | null>(null);
  const running    = useRef(false);
  const configRef  = useRef<BotConfig | null>(null);
  const S          = useRef({
    initialStake:    0.5,
    stake:           0.5,
    typeIndex:       0,
    contractTypes:   ['DIGITEVEN', 'DIGITODD'] as string[],
    totalProfit:     0,
    tradeCount:      0,
    wins:            0,
    refBalance:      0,
    pendingTrade:    false,
    firstTick:       true,
    currency:        'USD',
    reqId:           0,
  });

  const log = useCallback((text: string, type: TradeLogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setLogs(p => [{ id: `${Date.now()}${Math.random()}`, time, type, text }, ...p].slice(0, 200));
  }, []);

  const stop = useCallback(() => {
    running.current = false;
    wsRef.current?.close();
    wsRef.current = null;
    setStatus('stopped');
    setActiveTrade('');
    log('Bot stopped.', 'info');
  }, [log]);

  const placeTrade = useCallback((ws: WebSocket, cfg: BotConfig) => {
    const s = S.current;
    const raw = s.contractTypes[s.typeIndex];
    const [contractType, barrier] = raw.split(' ');
    setActiveTrade(`${raw} @ $${s.stake.toFixed(2)}`);
    log(`PLACING ${raw} | Stake: $${s.stake.toFixed(2)}`, 'info');
    ws.send(JSON.stringify({
      buy: 1,
      price: s.stake,
      parameters: {
        amount: s.stake,
        basis: 'stake',
        contract_type: contractType,
        currency: s.currency,
        duration: 1,
        duration_unit: 't',
        symbol: cfg.symbol,
        ...(barrier ? { barrier } : {}),
      },
      req_id: ++s.reqId,
    }));
  }, [log]);

  const start = useCallback((cfg: BotConfig, token: string) => {
    // Reset
    const contractTypes = cfg.mode === 'EVEN_ODD'
      ? ['DIGITEVEN', 'DIGITODD']
      : [`DIGITOVER ${cfg.barrier}`, `DIGITUNDER ${cfg.barrier}`];

    S.current = {
      initialStake: cfg.stake, stake: cfg.stake,
      typeIndex: 0, contractTypes,
      totalProfit: 0, tradeCount: 0, wins: 0,
      refBalance: 0, pendingTrade: false, firstTick: true,
      currency: 'USD', reqId: 0,
    };
    configRef.current = cfg;
    setTotalProfit(0); setTradeCount(0); setWins(0);
    setBalance(null); setLogs([]); setActiveTrade('');
    setStatus('connecting');
    running.current = true;

    log('Connecting to Deriv...', 'info');
    const ws = new WebSocket(DERIV_WS);
    wsRef.current = ws;

    ws.onopen = () => {
      log('Authorizing session...', 'info');
      ws.send(JSON.stringify({ authorize: token, req_id: ++S.current.reqId }));
    };

    ws.onclose = () => {
      if (running.current) {
        log('Connection lost.', 'error');
        setStatus('stopped');
        running.current = false;
        setActiveTrade('');
      }
    };

    ws.onerror = () => {
      log('WebSocket error.', 'error');
      setStatus('stopped');
      running.current = false;
    };

    ws.onmessage = (e) => {
      if (!running.current) return;
      const data = JSON.parse(e.data);
      const s    = S.current;
      const config = configRef.current!;

      // ── Authorize ──
      if (data.msg_type === 'authorize') {
        if (data.error) {
          log(`Auth failed: ${data.error.message}`, 'error');
          setStatus('stopped'); running.current = false; return;
        }
        const bal = parseFloat(data.authorize?.balance ?? 0);
        const cur = data.authorize?.currency ?? 'USD';
        s.refBalance = bal; s.currency = cur;
        setBalance(bal); setCurrency(cur);
        log(`Authorized | Balance: ${bal.toFixed(2)} ${cur}`, 'info');
        setStatus('running');
        ws.send(JSON.stringify({ ticks: config.symbol, subscribe: 1, req_id: ++s.reqId }));
        return;
      }

      // ── Tick ──
      if (data.msg_type === 'tick') {
        const quote  = data.tick?.quote ?? 0;
        const pip    = data.tick?.pip_size ?? 2;
        const digit  = Math.round(quote * Math.pow(10, pip)) % 10;
        const isEven = digit % 2 === 0;
        setLastDigit(digit);
        setLastQuote(String(quote));
        setDigitHistory(p => [{ digit, isEven }, ...p].slice(0, 20));

        if (s.firstTick) {
          s.firstTick = false;
          placeTrade(ws, config);
          return;
        }

        if (s.pendingTrade) {
          // Fetch result via statement
          ws.send(JSON.stringify({
            statement: 1, description: 1, limit: 1, offset: 0,
            action_type: 'sell', req_id: ++s.reqId,
          }));
        }
        return;
      }

      // ── Buy response ──
      if (data.msg_type === 'buy') {
        if (data.error) {
          log(`Trade error: ${data.error.message}`, 'error');
          stop(); return;
        }
        s.pendingTrade = true;
        s.tradeCount++;
        setTradeCount(s.tradeCount);
        return;
      }

      // ── Statement (result) ──
      if (data.msg_type === 'statement') {
        if (!s.pendingTrade) return;
        const txns = data.statement?.transactions ?? [];
        if (!txns.length) return;

        const newBal = parseFloat(txns[0].balance_after ?? s.refBalance);
        const profit = Math.round((newBal - s.refBalance) * 100) / 100;

        // Statement not ready yet (profit === 0 means contract still open)
        if (profit === 0) return;

        const won = profit > 0;
        s.totalProfit = Math.round((s.totalProfit + profit) * 100) / 100;
        if (won) s.wins++;
        s.refBalance    = newBal;
        s.pendingTrade  = false;

        setBalance(newBal);
        setTotalProfit(s.totalProfit);
        setWins(s.wins);

        const ps = (profit >= 0 ? '+' : '') + profit.toFixed(2);
        log(`${won ? '✅ WIN' : '❌ LOSS'} | P&L: $${ps} | Total: $${s.totalProfit.toFixed(2)}`, won ? 'win' : 'loss');

        // Take Profit / Stop Loss
        if (s.totalProfit >= config.takeProfit) {
          log('✅ Take Profit reached! Bot stopped.', 'win'); stop(); return;
        }
        if (s.totalProfit <= -Math.abs(config.stopLoss)) {
          log('⛔ Stop Loss reached! Bot stopped.', 'loss'); stop(); return;
        }

        // Martingale
        if (won) {
          s.stake = s.initialStake;
        } else {
          s.stake     = Math.round(s.stake * 2.1 * 100) / 100;
          s.typeIndex = 1 - s.typeIndex;
        }

        placeTrade(ws, config);
      }
    };
  }, [log, stop, placeTrade]);

  return {
    status, balance, currency, totalProfit, tradeCount, wins,
    lastDigit, lastQuote, digitHistory, logs, activeTrade,
    start, stop,
  };
}

// ── Component ──────────────────────────────────────────────────────────────────
export function FlashBotPage() {
  const { auth } = useDerivWSContext();
  const { authState, activeAccount, accounts } = auth as any;
  const isAuthenticated = authState === 'authenticated';

  const [config, setConfig] = useState<BotConfig>({
    symbol: 'R_100', mode: 'EVEN_ODD', barrier: 5,
    stake: 0.50, takeProfit: 1.00, stopLoss: 4.00,
  });

  const bot      = useFlashBot();
  const appName  = process.env.NEXT_PUBLIC_DERIV_APP_NAME ?? 'OmoshFX';
  const isRunning = bot.status === 'running' || bot.status === 'connecting';
  const winRate  = bot.tradeCount > 0 ? Math.round((bot.wins / bot.tradeCount) * 100) : null;

  const handleStart = useCallback(() => {
    if (!isAuthenticated) return;
    // Get token directly from @deriv/core storage
    const authInfo = getAuthInfo();
    const token = authInfo?.access_token;
    if (!token) {
      alert('Could not retrieve session token. Please log out and log in again.');
      return;
    }
    bot.start(config, token);
  }, [isAuthenticated, config, bot]);

  const statusColor = {
    idle:       '#4a6070',
    connecting: '#ffd700',
    running:    '#00ff88',
    stopped:    '#ff3355',
  }[bot.status];

  return (
    <div style={{ minHeight: '100vh', background: '#060a0f', color: '#c8dde8', fontFamily: "'Exo 2', 'Segoe UI', sans-serif", position: 'relative' }}>

      {/* Scanline */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 999, background: 'repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.06) 2px,rgba(0,0,0,0.06) 4px)' }} />

      {/* Header */}
      <header style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', height: 56, borderBottom: '1px solid #1a2a3a', background: 'linear-gradient(90deg,#060a0f,#0a1520,#060a0f)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
            <div style={{ width: 32, height: 32, borderRadius: 6, background: '#0c1219', border: '1px solid #1a2a3a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, color: '#00e5ff', fontFamily: 'monospace' }}>{appName.charAt(0)}</div>
            <span style={{ fontWeight: 600, fontSize: 16, color: '#c8dde8' }}>{appName}</span>
          </Link>
          <nav style={{ display: 'flex', gap: 4 }}>
            {[
              { href: '/',          label: 'Trade'     },
              { href: '/analysis',  label: 'Analysis'  },
              { href: '/bot',       label: 'Bot'       },
              { href: '/flash-bot', label: '⚡ Flash Bot' },
            ].map(n => (
              <Link key={n.href} href={n.href} style={{ padding: '4px 12px', borderRadius: 20, fontSize: 13, textDecoration: 'none', background: n.href === '/flash-bot' ? 'rgba(0,229,255,0.1)' : 'transparent', color: n.href === '/flash-bot' ? '#00e5ff' : '#4a6070', fontWeight: n.href === '/flash-bot' ? 600 : 400, border: n.href === '/flash-bot' ? '1px solid rgba(0,229,255,0.3)' : '1px solid transparent' }}>{n.label}</Link>
            ))}
          </nav>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {isAuthenticated && activeAccount && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {accounts.length > 1 && (
                <select onChange={e => (auth as any).switchAccount(e.target.value)} value={activeAccount.account_id} style={{ padding: '4px 8px', borderRadius: 4, fontSize: 11, border: '1px solid #1a2a3a', background: '#0c1219', color: '#c8dde8', cursor: 'pointer', fontFamily: 'monospace' }}>
                  {accounts.map((a: any) => <option key={a.account_id} value={a.account_id}>{a.account_type === 'demo' ? 'DEMO' : 'REAL'} — {parseFloat(a.balance).toFixed(2)} {a.currency}</option>)}
                </select>
              )}
              <div style={{ fontFamily: 'monospace', fontSize: 11, padding: '4px 12px', border: `1px solid ${activeAccount.account_type === 'demo' ? '#00e5ff' : '#ff3355'}`, borderRadius: 2, color: activeAccount.account_type === 'demo' ? '#00e5ff' : '#ff3355', letterSpacing: 2 }}>
                {activeAccount.account_type === 'demo' ? 'DEMO' : 'LIVE ⚠'}
              </div>
            </div>
          )}
          {!isAuthenticated && (
            <button onClick={() => (auth as any).login()} style={{ padding: '5px 16px', background: 'transparent', border: '1px solid #00e5ff', color: '#00e5ff', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11, letterSpacing: 2 }}>LOG IN</button>
          )}
          {/* Status badge */}
          <div style={{ fontFamily: 'monospace', fontSize: 11, padding: '5px 14px', borderRadius: 2, border: `1px solid ${statusColor}`, color: statusColor, letterSpacing: 2, textTransform: 'uppercase', boxShadow: bot.status === 'running' ? '0 0 12px rgba(0,255,136,0.3)' : 'none', transition: 'all 0.3s' }}>
            {bot.status}
          </div>
        </div>
      </header>

      {/* Not logged in warning */}
      {!isAuthenticated && (
        <div style={{ position: 'fixed', top: 56, left: 0, right: 0, zIndex: 40, background: 'rgba(255,51,85,0.08)', borderBottom: '1px solid rgba(255,51,85,0.3)', padding: '10px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: '#ff3355', fontFamily: 'monospace' }}>
          <span>⚠ LOGIN REQUIRED — Flash Bot needs your Deriv session to place real trades</span>
          <button onClick={() => (auth as any).login()} style={{ padding: '3px 12px', background: 'transparent', border: '1px solid #ff3355', color: '#ff3355', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11, letterSpacing: 2 }}>LOG IN</button>
        </div>
      )}

      {/* Main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gridTemplateRows: 'auto 1fr', height: 'calc(100vh - 56px)', marginTop: 56, gap: 1, background: '#1a2a3a' }}>

        {/* ── LEFT CONFIG ── */}
        <div style={{ gridRow: '1 / -1', background: '#0c1219', padding: 24, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

          <div>
            <SectionTitle>Trade Settings</SectionTitle>
            <FieldLabel>Symbol</FieldLabel>
            <select value={config.symbol} onChange={e => setConfig(c => ({ ...c, symbol: e.target.value }))} style={selectSt} disabled={isRunning}>
              {SYMBOLS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>

            <FieldLabel>Mode</FieldLabel>
            <select value={config.mode} onChange={e => setConfig(c => ({ ...c, mode: e.target.value as BotMode }))} style={selectSt} disabled={isRunning}>
              <option value="EVEN_ODD">Even / Odd</option>
              <option value="OVER_UNDER">Over / Under</option>
            </select>

            {config.mode === 'OVER_UNDER' && (
              <>
                <FieldLabel>Barrier (0–9)</FieldLabel>
                <input type="number" value={config.barrier} min={0} max={9} onChange={e => setConfig(c => ({ ...c, barrier: parseInt(e.target.value) }))} style={inputSt} disabled={isRunning} />
              </>
            )}

            <FieldLabel>Initial Stake (USD)</FieldLabel>
            <input type="number" value={config.stake} min={0.35} step={0.01} onChange={e => setConfig(c => ({ ...c, stake: parseFloat(e.target.value) }))} style={inputSt} disabled={isRunning} />
          </div>

          <div>
            <SectionTitle>Risk Management</SectionTitle>
            <FieldLabel>Take Profit (USD)</FieldLabel>
            <input type="number" value={config.takeProfit} min={0.01} step={0.01} onChange={e => setConfig(c => ({ ...c, takeProfit: parseFloat(e.target.value) }))} style={inputSt} disabled={isRunning} />
            <FieldLabel>Stop Loss (USD)</FieldLabel>
            <input type="number" value={config.stopLoss} min={0.01} step={0.01} onChange={e => setConfig(c => ({ ...c, stopLoss: parseFloat(e.target.value) }))} style={inputSt} disabled={isRunning} />
          </div>

          <div>
            <button
              onClick={handleStart}
              disabled={isRunning || !isAuthenticated}
              style={{ width: '100%', padding: 12, fontFamily: 'monospace', fontSize: 13, letterSpacing: 3, textTransform: 'uppercase', border: '1px solid #00ff88', background: 'transparent', color: '#00ff88', cursor: isRunning || !isAuthenticated ? 'not-allowed' : 'pointer', opacity: isRunning || !isAuthenticated ? 0.4 : 1, transition: 'all 0.2s', marginBottom: 8 }}
            >▶ START BOT</button>
            <button
              onClick={bot.stop}
              disabled={!isRunning}
              style={{ width: '100%', padding: 12, fontFamily: 'monospace', fontSize: 13, letterSpacing: 3, textTransform: 'uppercase', border: '1px solid #ff3355', background: 'transparent', color: '#ff3355', cursor: !isRunning ? 'not-allowed' : 'pointer', opacity: !isRunning ? 0.4 : 1, transition: 'all 0.2s' }}
            >■ STOP BOT</button>
          </div>

          <div style={{ marginTop: 'auto', paddingTop: 16, borderTop: '1px solid #1a2a3a', fontFamily: 'monospace', fontSize: 11, color: '#4a6070', lineHeight: 2 }}>
            <div style={{ color: '#00e5ff', marginBottom: 6, letterSpacing: 2, fontSize: 10 }}>STRATEGY</div>
            Martingale: 2.1× on loss<br />
            Type switches on loss<br />
            Resets to base stake on win<br />
            Duration: 1 tick per trade
          </div>
        </div>

        {/* ── TOP RIGHT: STATS ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 1, background: '#1a2a3a', height: 'fit-content' }}>
          {[
            { label: 'Balance',  value: bot.balance !== null ? `${bot.balance.toFixed(2)} ${bot.currency}` : '—', color: '#00e5ff' },
            { label: 'Total P&L', value: bot.totalProfit !== 0 ? `${bot.totalProfit >= 0 ? '+' : ''}${bot.totalProfit.toFixed(2)}` : '—', color: bot.totalProfit > 0 ? '#00ff88' : bot.totalProfit < 0 ? '#ff3355' : '#00e5ff' },
            { label: 'Trades',   value: String(bot.tradeCount), color: '#00e5ff' },
            { label: 'Wins',     value: String(bot.wins),       color: '#00e5ff' },
            { label: 'Win Rate', value: winRate !== null ? `${winRate}%` : '—', color: winRate !== null ? (winRate >= 50 ? '#00ff88' : '#ff3355') : '#00e5ff' },
          ].map(s => (
            <div key={s.label} style={{ background: '#0c1219', padding: '20px 16px', textAlign: 'center' }}>
              <div style={{ fontFamily: 'monospace', fontSize: 10, letterSpacing: 2, color: '#4a6070', textTransform: 'uppercase', marginBottom: 8 }}>{s.label}</div>
              <div style={{ fontFamily: 'monospace', fontSize: 22, color: s.color, transition: 'color 0.3s' }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* ── BOTTOM RIGHT: TICK + LOG ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: '#1a2a3a', overflow: 'hidden' }}>

          {/* Tick panel */}
          <div style={{ background: '#0c1219', padding: 20, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <SectionTitle>Live Tick</SectionTitle>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <div style={{
                fontFamily: 'monospace', fontSize: 96, lineHeight: 1, transition: 'all 0.15s',
                color: bot.lastDigit === null ? '#4a6070' : bot.lastDigit % 2 === 0 ? '#00ff88' : '#ffd700',
                textShadow: bot.lastDigit === null ? 'none' : bot.lastDigit % 2 === 0 ? '0 0 40px rgba(0,255,136,0.5)' : '0 0 40px rgba(255,215,0,0.5)',
              }}>
                {bot.lastDigit ?? '—'}
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 13, color: '#4a6070', letterSpacing: 2 }}>
                {bot.lastQuote || 'Waiting for ticks...'}
              </div>
              {bot.activeTrade && isRunning && (
                <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#00e5ff', letterSpacing: 1, marginTop: 4, padding: '4px 12px', border: '1px solid rgba(0,229,255,0.2)', borderRadius: 2 }}>
                  {bot.activeTrade}
                </div>
              )}
            </div>
            {/* Digit history */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 12 }}>
              {bot.digitHistory.map((d, i) => (
                <div key={i} style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace', fontSize: 12, border: `1px solid ${i === 0 ? '#00e5ff' : d.isEven ? 'rgba(0,255,136,0.4)' : 'rgba(255,215,0,0.4)'}`, color: i === 0 ? '#00e5ff' : d.isEven ? '#00ff88' : '#ffd700' }}>
                  {d.digit}
                </div>
              ))}
            </div>
          </div>

          {/* Trade log */}
          <div style={{ background: '#0c1219', padding: 20, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <SectionTitle>Trade Log</SectionTitle>
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {bot.logs.length === 0 && (
                <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#4a6070', marginTop: 8 }}>Waiting to start...</div>
              )}
              {bot.logs.map(entry => (
                <div key={entry.id} style={{ fontFamily: 'monospace', fontSize: 11, padding: '6px 10px', lineHeight: 1.5, borderLeft: `2px solid ${entry.type === 'win' ? '#00ff88' : entry.type === 'loss' ? '#ff3355' : entry.type === 'error' ? '#ff6677' : '#1a2a3a'}`, color: entry.type === 'win' || entry.type === 'loss' ? '#c8dde8' : entry.type === 'error' ? '#ff6677' : '#4a6070' }}>
                  [{entry.time}] {entry.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: 'monospace', fontSize: 10, letterSpacing: 3, color: '#00e5ff', textTransform: 'uppercase', marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #1a2a3a' }}>{children}</div>;
}
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, letterSpacing: 1, color: '#4a6070', textTransform: 'uppercase', marginBottom: 5, marginTop: 12, fontFamily: 'monospace' }}>{children}</div>;
}
const selectSt: React.CSSProperties = { width: '100%', background: '#080e14', border: '1px solid #1a2a3a', color: '#c8dde8', fontFamily: 'monospace', fontSize: 13, padding: '8px 12px', outline: 'none', cursor: 'pointer', marginBottom: 4 };
const inputSt:  React.CSSProperties = { width: '100%', background: '#080e14', border: '1px solid #1a2a3a', color: '#c8dde8', fontFamily: 'monospace', fontSize: 13, padding: '8px 12px', outline: 'none', marginBottom: 4, boxSizing: 'border-box' };
