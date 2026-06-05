'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import { useProposal, useBuy } from '@deriv/core';
import type { ProposalParams } from '@deriv/core';

// ── Types ──────────────────────────────────────────────────────────────────
type TradeType = 'even-odd' | 'over-under' | 'matches-differs';
type ContractMode = 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITMATCH' | 'DIGITDIFF';
type BotStatus = 'idle' | 'running' | 'stopped';
type SignalStrength = 'strong' | 'moderate' | 'weak' | 'none';

interface DigitResult { digit: number; even: boolean; timestamp: number }
interface BotRule {
  tradeType: TradeType;
  digit: number;
  stake: string;
  duration: number;
  consecutiveTrigger: number;
  percentageTrigger: number;
  hotColdTrigger: 'hot' | 'cold' | 'none';
  maxTrades: number;
  stopLoss: number;
  takeProfit: number;
}
interface TradeLog {
  id: string;
  time: string;
  signal: string;
  contractMode: string;
  stake: string;
  result: 'pending' | 'won' | 'lost';
  profit: number;
}

const SYMBOLS = [
  { value: '1HZ100V', label: 'Volatility 100 (1s)' },
  { value: '1HZ75V',  label: 'Volatility 75 (1s)'  },
  { value: '1HZ50V',  label: 'Volatility 50 (1s)'  },
  { value: '1HZ25V',  label: 'Volatility 25 (1s)'  },
  { value: '1HZ10V',  label: 'Volatility 10 (1s)'  },
  { value: 'R_100',   label: 'Volatility 100'       },
  { value: 'R_75',    label: 'Volatility 75'        },
  { value: 'R_50',    label: 'Volatility 50'        },
];

const DEFAULT_RULE: BotRule = {
  tradeType: 'even-odd',
  digit: 5,
  stake: '1',
  duration: 5,
  consecutiveTrigger: 3,
  percentageTrigger: 55,
  hotColdTrigger: 'none',
  maxTrades: 10,
  stopLoss: 20,
  takeProfit: 50,
};

// ── Live ticks hook ────────────────────────────────────────────────────────
function useLiveTicks(symbol: string) {
  const [digits, setDigits] = useState<DigitResult[]>([]);
  const [connected, setConn] = useState(false);
  const pipRef = useRef(2);

  useEffect(() => {
    setDigits([]);
    setConn(false);
    const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');
    ws.onopen = () => {
      setConn(true);
      ws.send(JSON.stringify({ ticks_history: symbol, count: 100, end: 'latest', style: 'ticks', subscribe: 1 }));
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
        const ts: number[] = msg.history?.times ?? [];
        setDigits(ps.map((p, i) => { const digit = Math.round(p * factor) % 10; return { digit, even: digit % 2 === 0, timestamp: ts[i] }; }));
      }
      if (msg.msg_type === 'tick') {
        const pip = msg.tick?.pip_size ?? pipRef.current;
        pipRef.current = pip;
        const factor = Math.pow(10, pip);
        const digit = Math.round((msg.tick?.quote ?? 0) * factor) % 10;
        setDigits(prev => [...prev, { digit, even: digit % 2 === 0, timestamp: msg.tick?.epoch ?? Date.now() }].slice(-100));
      }
    };
    return () => { ws.close(); };
  }, [symbol]);

  return { digits, connected };
}

// ── Signal analysis ────────────────────────────────────────────────────────
function analyzeSignal(digits: DigitResult[], rule: BotRule): { signal: string; strength: SignalStrength; shouldTrade: boolean; mode: ContractMode } {
  if (digits.length < 10) return { signal: 'Waiting for data...', strength: 'none', shouldTrade: false, mode: 'DIGITEVEN' };
  const last50 = digits.slice(-50);
  const total = last50.length;
  const evenCount = last50.filter(d => d.even).length;
  const oddCount = total - evenCount;
  const evenPct = Math.round((evenCount / total) * 100);
  const oddPct = 100 - evenPct;
  const counts = Array.from({ length: 10 }, (_, i) => last50.filter(d => d.digit === i).length);
  const pcts = counts.map(c => Math.round((c / total) * 100));
  const lastN = digits.slice(-Math.max(rule.consecutiveTrigger, 1));
  const hotDigit = pcts.indexOf(Math.max(...pcts));
  const coldDigit = pcts.indexOf(Math.min(...pcts));
  const lastDigit = lastN[lastN.length - 1]?.digit;

  let signal = '', strength: SignalStrength = 'none', shouldTrade = false, mode: ContractMode = 'DIGITEVEN';

  if (rule.tradeType === 'even-odd') {
    const allOdd = lastN.every(d => !d.even);
    const allEven = lastN.every(d => d.even);
    if (rule.consecutiveTrigger > 0 && allOdd) { signal = `${rule.consecutiveTrigger} consecutive ODD → buy EVEN`; strength = 'strong'; shouldTrade = true; mode = 'DIGITEVEN'; }
    else if (rule.consecutiveTrigger > 0 && allEven) { signal = `${rule.consecutiveTrigger} consecutive EVEN → buy ODD`; strength = 'strong'; shouldTrade = true; mode = 'DIGITODD'; }
    else if (rule.percentageTrigger > 0 && oddPct >= rule.percentageTrigger) { signal = `ODD at ${oddPct}% → buy EVEN`; strength = oddPct >= 60 ? 'strong' : 'moderate'; shouldTrade = true; mode = 'DIGITEVEN'; }
    else if (rule.percentageTrigger > 0 && evenPct >= rule.percentageTrigger) { signal = `EVEN at ${evenPct}% → buy ODD`; strength = evenPct >= 60 ? 'strong' : 'moderate'; shouldTrade = true; mode = 'DIGITODD'; }
    else { signal = `Even ${evenPct}% | Odd ${oddPct}% — waiting`; strength = 'weak'; }
  } else if (rule.tradeType === 'over-under') {
    const overPct = Math.round((last50.filter(d => d.digit > rule.digit).length / total) * 100);
    const underPct = Math.round((last50.filter(d => d.digit < rule.digit).length / total) * 100);
    const allOver = lastN.every(d => d.digit > rule.digit);
    const allUnder = lastN.every(d => d.digit < rule.digit);
    if (rule.consecutiveTrigger > 0 && allOver) { signal = `${rule.consecutiveTrigger} consecutive OVER → buy UNDER`; strength = 'strong'; shouldTrade = true; mode = 'DIGITUNDER'; }
    else if (rule.consecutiveTrigger > 0 && allUnder) { signal = `${rule.consecutiveTrigger} consecutive UNDER → buy OVER`; strength = 'strong'; shouldTrade = true; mode = 'DIGITOVER'; }
    else if (rule.percentageTrigger > 0 && overPct >= rule.percentageTrigger) { signal = `OVER at ${overPct}% → buy UNDER`; strength = 'moderate'; shouldTrade = true; mode = 'DIGITUNDER'; }
    else if (rule.percentageTrigger > 0 && underPct >= rule.percentageTrigger) { signal = `UNDER at ${underPct}% → buy OVER`; strength = 'moderate'; shouldTrade = true; mode = 'DIGITOVER'; }
    else { signal = `Over ${overPct}% | Under ${underPct}% — waiting`; strength = 'weak'; }
  } else {
    const digitPct = pcts[rule.digit];
    const allSame = lastN.every(d => d.digit === lastDigit);
    if (rule.hotColdTrigger === 'hot') { signal = `Digit ${hotDigit} HOT (${pcts[hotDigit]}%) → buy DIFFERS`; strength = 'moderate'; shouldTrade = true; mode = 'DIGITDIFF'; }
    else if (rule.hotColdTrigger === 'cold') { signal = `Digit ${coldDigit} COLD (${pcts[coldDigit]}%) → buy MATCHES`; strength = 'moderate'; shouldTrade = true; mode = 'DIGITMATCH'; }
    else if (rule.consecutiveTrigger > 0 && allSame) { signal = `Digit ${lastDigit} appeared ${rule.consecutiveTrigger}x → buy DIFFERS`; strength = 'strong'; shouldTrade = true; mode = 'DIGITDIFF'; }
    else if (rule.percentageTrigger > 0 && digitPct >= rule.percentageTrigger) { signal = `Digit ${rule.digit} at ${digitPct}% → buy DIFFERS`; strength = 'moderate'; shouldTrade = true; mode = 'DIGITDIFF'; }
    else { signal = `Digit ${rule.digit} at ${digitPct}% — waiting`; strength = 'weak'; }
  }
  return { signal, strength, shouldTrade, mode };
}

const strengthColor = { strong: '#22c55e', moderate: '#f59e0b', weak: '#6b7280', none: '#6b7280' };
const strengthBg    = { strong: '#dcfce7', moderate: '#fef3c7', weak: 'var(--color-background-tertiary)', none: 'var(--color-background-tertiary)' };

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--color-background-secondary)', borderRadius: 12, padding: '16px 20px', marginBottom: 16, border: '1px solid var(--color-border-tertiary)' }}>
      {title && <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12, color: 'var(--color-text-primary)' }}>{title}</div>}
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const selectStyle = { width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13, border: '1px solid var(--color-border-secondary)', background: 'var(--color-background-primary)', color: 'var(--color-text-primary)', cursor: 'pointer' };
const inputStyle  = { width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13, border: '1px solid var(--color-border-secondary)', background: 'var(--color-background-primary)', color: 'var(--color-text-primary)', boxSizing: 'border-box' as const };

// ── Main ───────────────────────────────────────────────────────────────────
export function BotPage() {
  const { ws, isConnected: wsConnected, auth } = useDerivWSContext();
  const { authState, activeAccount, accounts, onLogin, onSignUp, login, signUp, switchAccount } = auth as any;
  const isAuthenticated = authState === 'authenticated';

  const [symbol, setSymbol]   = useState(SYMBOLS[0].value);
  const [rule, setRule]       = useState<BotRule>(DEFAULT_RULE);
  const [botStatus, setBotStatus] = useState<BotStatus>('idle');
  const [logs, setLogs]       = useState<TradeLog[]>([]);
  const [totalProfit, setTotalProfit] = useState(0);
  const [tradeCount, setTradeCount]   = useState(0);
  const [lastTradeTime, setLastTradeTime] = useState(0);
  const [currentMode, setCurrentMode] = useState<ContractMode>('DIGITEVEN');
  const [shouldBuy, setShouldBuy] = useState(false);

  const { digits, connected: tickConnected } = useLiveTicks(symbol);
  const { signal, strength, shouldTrade, mode } = analyzeSignal(digits, rule);
  const appName = process.env.NEXT_PUBLIC_DERIV_APP_NAME ?? 'OmoshFX';

  // Build proposal params for real trading
  const stakeNum = parseFloat(rule.stake) || 1;
  const needsBarrier = currentMode !== 'DIGITEVEN' && currentMode !== 'DIGITODD';
  const proposalParams: ProposalParams | null = isAuthenticated && wsConnected && shouldBuy ? {
    contractType: currentMode,
    symbol,
    amount: stakeNum,
    duration: rule.duration,
    durationUnit: 't',
    basis: 'stake',
    currency: activeAccount?.currency ?? 'USD',
    ...(needsBarrier ? { barrier: rule.digit } : {}),
  } : null;

  const { proposal } = useProposal(ws, wsConnected, proposalParams);
  const { buyContract, isBuying, buyResult, buyError, clearBuyResult } = useBuy(ws, wsConnected);

  // Handle buy result
  useEffect(() => {
    if (!buyResult) return;
    const profit = buyResult.buyPrice ? buyResult.payout - buyResult.buyPrice : 0;
    setLogs((prev) => [{
      id: Date.now().toString(),
      time: new Date().toLocaleTimeString(),
      signal,
      contractMode: currentMode,
      stake: rule.stake,
      result: (profit >= 0 ? 'won' : 'lost') as TradeLog['result'],
      profit: Math.round(profit * 100) / 100,
    }, ...prev].slice(0, 50));
    setTotalProfit(p => Math.round((p + profit) * 100) / 100);
    setTradeCount(c => c + 1);
    setShouldBuy(false);
    clearBuyResult();
  }, [buyResult]);

  useEffect(() => {
    if (!buyError) return;
    setShouldBuy(false);
  }, [buyError]);

  // Bot logic — triggers on new ticks
  useEffect(() => {
    if (botStatus !== 'running') return;
    const now = Date.now();
    if (now - lastTradeTime < 7000) return;
    if (rule.maxTrades > 0 && tradeCount >= rule.maxTrades) { setBotStatus('stopped'); return; }
    if (rule.stopLoss > 0 && totalProfit <= -rule.stopLoss) { setBotStatus('stopped'); return; }
    if (rule.takeProfit > 0 && totalProfit >= rule.takeProfit) { setBotStatus('stopped'); return; }
    if (!shouldTrade) return;

    setCurrentMode(mode);
    setLastTradeTime(now);

    if (isAuthenticated && wsConnected) {
      setShouldBuy(true);
    } else {
      // Simulation mode when not logged in
      const won = Math.random() > 0.45;
      const profit = won ? stakeNum * 0.89 : -stakeNum;
      setLogs((prev) => [{ id: Date.now().toString(), time: new Date().toLocaleTimeString(), signal, contractMode: mode, stake: rule.stake, result: (won ? 'won' : 'lost') as TradeLog['result'], profit: Math.round(profit * 100) / 100 }, ...prev].slice(0, 50));
      setTotalProfit(p => Math.round((p + profit) * 100) / 100);
      setTradeCount(c => c + 1);
    }
  }, [digits, botStatus]);

  // Buy when proposal is ready
  useEffect(() => {
    if (shouldBuy && proposal && !isBuying) {
      buyContract(proposal);
    }
  }, [shouldBuy, proposal, isBuying]);

  const updateRule = (key: keyof BotRule, value: string | number) => setRule(prev => ({ ...prev, [key]: value }));
  const startBot = () => { setLogs([]); setTotalProfit(0); setTradeCount(0); setLastTradeTime(0); setBotStatus('running'); };
  const stopBot  = () => { setBotStatus('stopped'); setShouldBuy(false); };

  return (
    <>
      {/* Header */}
      <header style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', height: 56, borderBottom: '1px solid var(--color-border-tertiary)', background: 'var(--color-background-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
            <div style={{ width: 32, height: 32, borderRadius: 6, background: 'var(--color-background-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, color: 'var(--color-text-primary)' }}>{appName.charAt(0)}</div>
            <span style={{ fontWeight: 600, fontSize: 16, color: 'var(--color-text-primary)' }}>{appName}</span>
          </Link>
          <nav style={{ display: 'flex', gap: 4 }}>
            {[{ href: '/', label: 'Trade' }, { href: '/analysis', label: 'Analysis' }, { href: '/bot', label: 'Bot' }].map(n => (
              <Link key={n.href} href={n.href} style={{ padding: '4px 12px', borderRadius: 20, fontSize: 13, textDecoration: 'none', background: n.href === '/bot' ? 'var(--color-background-tertiary)' : 'transparent', color: n.href === '/bot' ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', fontWeight: n.href === '/bot' ? 500 : 400 }}>{n.label}</Link>
            ))}
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {isAuthenticated && activeAccount && (
            <div style={{ fontSize: 13, color: 'var(--color-text-primary)', fontWeight: 600 }}>
              <span style={{ fontSize: 11, color: activeAccount.account_type === 'demo' ? '#f59e0b' : '#22c55e', marginRight: 4 }}>{activeAccount.account_type === 'demo' ? 'DEMO' : 'REAL'}</span>
              {parseFloat(activeAccount.balance).toFixed(2)} {activeAccount.currency}
            </div>
          )}
          {!isAuthenticated && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => auth.login()} style={{ padding: '6px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: 'none', background: '#22c55e', color: '#fff', cursor: 'pointer' }}>Log in</button>
              <button onClick={() => auth.signUp()} style={{ padding: '6px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1px solid var(--color-border-secondary)', background: 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer' }}>Sign up</button>
            </div>
          )}
        </div>
      </header>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '72px 16px 32px', fontFamily: 'var(--font-sans)' }}>

        {/* Title */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: 'var(--color-text-primary)' }}>Bot Builder</h2>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>Configure rules and let the bot trade automatically</p>
          </div>
          <select value={symbol} onChange={e => setSymbol(e.target.value)} style={selectStyle}>
            {SYMBOLS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>

        
          <div style={{ padding: '14px 18px', borderRadius: 10, marginBottom: 20, background: '#dcfce7', border: '1px solid #22c55e', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ fontSize: 13, color: '#15803d' }}>
              ✅ <b>Real trading active.</b> Bot will place actual trades on your {activeAccount?.account_type} account.
            </div>
            {accounts.length > 1 && (
              <select onChange={e => auth.switchAccount(e.target.value)} value={activeAccount?.account_id} style={{ padding: '6px 10px', borderRadius: 8, fontSize: 13, border: '1px solid #22c55e', background: '#fff', cursor: 'pointer' }}>
                {accounts.map((a: any) => (
                  <option key={a.account_id} value={a.account_id}>{a.account_type === 'demo' ? 'Demo' : 'Real'} — {parseFloat(a.balance).toFixed(2)} {a.currency}</option>
                ))}
              </select>
            )}
          </div>
        

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* Left — config */}
          <div>
            <Card title="Trade Settings">
              <Field label="Trade Type">
                <select value={rule.tradeType} onChange={e => updateRule('tradeType', e.target.value)} style={selectStyle}>
                  <option value="even-odd">Even / Odd</option>
                  <option value="over-under">Over / Under</option>
                  <option value="matches-differs">Matches / Differs</option>
                </select>
              </Field>
              {(rule.tradeType === 'over-under' || rule.tradeType === 'matches-differs') && (
                <Field label="Digit (0-9)">
                  <input type="number" value={rule.digit} min={0} max={9} onChange={e => updateRule('digit', parseInt(e.target.value))} style={inputStyle} />
                </Field>
              )}
              <Field label="Stake (USD)">
                <input type="number" value={rule.stake} min={0.35} step={0.5} onChange={e => updateRule('stake', e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Duration (Ticks)">
                <input type="number" value={rule.duration} min={1} max={10} onChange={e => updateRule('duration', parseInt(e.target.value))} style={inputStyle} />
              </Field>
            </Card>

            <Card title="Signal Rules">
              <Field label="Consecutive trigger (0 = off)">
                <input type="number" value={rule.consecutiveTrigger} min={0} max={10} onChange={e => updateRule('consecutiveTrigger', parseInt(e.target.value))} style={inputStyle} />
              </Field>
              <Field label="Percentage trigger % (0 = off)">
                <input type="number" value={rule.percentageTrigger} min={0} max={100} onChange={e => updateRule('percentageTrigger', parseInt(e.target.value))} style={inputStyle} />
              </Field>
              <Field label="Hot/Cold trigger">
                <select value={rule.hotColdTrigger} onChange={e => updateRule('hotColdTrigger', e.target.value)} style={selectStyle}>
                  <option value="none">Disabled</option>
                  <option value="hot">Buy on HOT digit</option>
                  <option value="cold">Buy on COLD digit</option>
                </select>
              </Field>
            </Card>

            <Card title="Risk Management">
              <Field label="Max trades (0 = unlimited)">
                <input type="number" value={rule.maxTrades} min={0} onChange={e => updateRule('maxTrades', parseInt(e.target.value))} style={inputStyle} />
              </Field>
              <Field label="Stop loss (USD)">
                <input type="number" value={rule.stopLoss} min={0} onChange={e => updateRule('stopLoss', parseInt(e.target.value))} style={inputStyle} />
              </Field>
              <Field label="Take profit (USD)">
                <input type="number" value={rule.takeProfit} min={0} onChange={e => updateRule('takeProfit', parseInt(e.target.value))} style={inputStyle} />
              </Field>
            </Card>
          </div>

          {/* Right — signal + controls */}
          <div>
            <Card title="Live Signal">
              <div style={{ padding: '12px 16px', borderRadius: 10, marginBottom: 16, background: strengthBg[strength], border: `1px solid ${strengthColor[strength]}` }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: strengthColor[strength], marginBottom: 4, textTransform: 'uppercase' }}>{strength} signal</div>
                <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)' }}>{signal}</div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 16 }}>
                {digits.slice(-20).map((d, i) => (
                  <span key={i} style={{ width: 24, height: 24, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, color: '#fff', background: rule.tradeType === 'even-odd' ? (d.even ? '#22c55e' : '#ef4444') : (d.digit > rule.digit ? '#ef4444' : d.digit < rule.digit ? '#22c55e' : '#6b7280') }}>
                    {rule.tradeType === 'even-odd' ? (d.even ? 'E' : 'O') : d.digit}
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={startBot} disabled={botStatus === 'running' || !tickConnected} style={{ flex: 1, padding: '10px 0', borderRadius: 8, fontWeight: 600, fontSize: 14, border: 'none', cursor: botStatus === 'running' || !tickConnected ? 'not-allowed' : 'pointer', background: botStatus === 'running' ? '#6b7280' : '#22c55e', color: '#fff' }}>
                  {botStatus === 'running' ? '● Running...' : '▶ Start Bot'}
                </button>
                <button onClick={stopBot} disabled={botStatus !== 'running'} style={{ flex: 1, padding: '10px 0', borderRadius: 8, fontWeight: 600, fontSize: 14, border: 'none', cursor: botStatus !== 'running' ? 'not-allowed' : 'pointer', background: botStatus !== 'running' ? '#6b7280' : '#ef4444', color: '#fff' }}>
                  ■ Stop Bot
                </button>
              </div>
            </Card>

            <Card title="Session Stats">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                {[{ label: 'Trades', value: tradeCount }, { label: 'Won', value: logs.filter(l => l.result === 'won').length }, { label: 'Lost', value: logs.filter(l => l.result === 'lost').length }].map(s => (
                  <div key={s.label} style={{ textAlign: 'center', padding: '10px 0', borderRadius: 8, background: 'var(--color-background-tertiary)' }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>{s.value}</div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{s.label}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, padding: '12px 16px', borderRadius: 8, background: 'var(--color-background-tertiary)', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Total P&L</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: totalProfit >= 0 ? '#22c55e' : '#ef4444' }}>{totalProfit >= 0 ? '+' : ''}{totalProfit.toFixed(2)} USD</div>
              </div>
            </Card>

            {botStatus !== 'idle' && (
              <div style={{ padding: '10px 16px', borderRadius: 8, marginBottom: 16, background: botStatus === 'running' ? '#dcfce7' : '#fee2e2', border: `1px solid ${botStatus === 'running' ? '#22c55e' : '#ef4444'}`, fontSize: 13, color: botStatus === 'running' ? '#15803d' : '#b91c1c', fontWeight: 500 }}>
                {botStatus === 'running' ? `🤖 Bot running ${isAuthenticated ? '(LIVE)' : '(simulation)'} — ${tradeCount}/${rule.maxTrades || '∞'} trades` : `⏹ Bot stopped — ${tradeCount} trades | P&L: ${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)} USD`}
              </div>
            )}
          </div>
        </div>

        {/* Trade log */}
        {logs.length > 0 && (
          <Card title="Trade Log">
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}>
                    {['Time', 'Signal', 'Mode', 'Stake', 'Result', 'P&L'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {logs.map(log => (
                    <tr key={log.id} style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}>
                      <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{log.time}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--color-text-primary)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.signal}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--color-text-primary)' }}>{log.contractMode}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--color-text-primary)' }}>${log.stake}</td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: log.result === 'won' ? '#dcfce7' : '#fee2e2', color: log.result === 'won' ? '#15803d' : '#b91c1c' }}>{log.result.toUpperCase()}</span>
                      </td>
                      <td style={{ padding: '8px 12px', fontWeight: 600, color: log.profit >= 0 ? '#22c55e' : '#ef4444' }}>{log.profit >= 0 ? '+' : ''}{log.profit.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
      <div style={{ position: 'fixed', bottom: 16, right: 16, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', padding: '6px 12px', borderRadius: 20, border: '1px solid var(--color-border-tertiary)', zIndex: 50 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: tickConnected ? '#22c55e' : '#ef4444', display: 'inline-block' }} />
        {tickConnected ? 'Live' : 'Connecting…'}
      </div>
    </>
  );
}
