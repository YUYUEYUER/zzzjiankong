import { useEffect, useMemo, useState } from 'react';
import {
  ArrowClockwise,
  CalendarBlank,
  CheckCircle,
  Copy,
  DotsThreeVertical,
  Flask,
  LinkSimple,
  PencilSimple,
  Wallet,
} from '@phosphor-icons/react';
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { Line } from 'react-chartjs-2';
import { api } from '../api.js';
import { compactNumber, formatDayLabel, money, platformLabel, relativeTime } from '../lib.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend, annotationPlugin);

export function AccountWorkspace({ account, upstream, snapshots, onRefresh, onEdit, onRecharge, busy, pushToast }) {
  const [range, setRange] = useState(7);
  const [formula, setFormula] = useState(account?.formula || 'x');
  const [testRaw, setTestRaw] = useState(account?.rawBalance || 0);
  const [testResult, setTestResult] = useState(account?.convertedCny || 0);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setFormula(account?.formula || 'x');
    setTestRaw(account?.rawBalance || 0);
    setTestResult(account?.convertedCny || 0);
  }, [account?.id, account?.formula, account?.rawBalance, account?.convertedCny]);

  const chartData = useMemo(() => {
    if (!account) return [];
    const cutoff = Date.now() - range * 86400000;
    // 每条快照只解析一次时间戳：先挂 ms 再过滤/排序，避免比较器里 O(n log n) 次 Date 构造。
    return snapshots
      .filter((item) => item.accountId === account.id)
      .map((item) => ({ ms: new Date(item.capturedAt).getTime(), value: Number(item.convertedCny) }))
      .filter((item) => item.ms >= cutoff)
      .sort((left, right) => left.ms - right.ms)
      .map((item) => ({ value: item.value, label: formatDayLabel(item.ms) }));
  }, [account, snapshots, range]);

  const lineData = useMemo(() => ({
    labels: chartData.map((item) => item.label),
    datasets: [{
      label: '折算人民币',
      data: chartData.map((item) => item.value),
      borderColor: '#1677ff',
      backgroundColor: 'rgba(22, 119, 255, 0.08)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: '#1677ff',
      pointHoverBorderColor: '#ffffff',
      pointHoverBorderWidth: 2,
      fill: true,
      stepped: 'after',
      tension: 0,
    }],
  }), [chartData]);

  const lineOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 10, right: 14, left: 2, bottom: 0 } },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: '#728096', font: { family: 'Inter Variable', size: 10 }, maxTicksLimit: 8 } },
      y: { beginAtZero: true, grid: { color: '#dce6f2', borderDash: [3, 5] }, border: { display: false }, ticks: { color: '#728096', font: { family: 'Inter Variable', size: 10 }, padding: 7 } },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(23, 32, 51, 0.94)',
        displayColors: false,
        padding: 9,
        titleFont: { family: 'Inter Variable', size: 10, weight: 500 },
        bodyFont: { family: 'Inter Variable', size: 12, weight: 650 },
        callbacks: { label: (context) => money(context.parsed.y) },
      },
      annotation: {
        annotations: {
          low: { type: 'line', yMin: Number(account.thresholdLow), yMax: Number(account.thresholdLow), borderColor: '#f05b52', borderWidth: 1, borderDash: [5, 4], label: { display: true, content: `低阈值 ${money(account.thresholdLow)}`, position: 'end', backgroundColor: 'rgba(255,255,255,.84)', color: '#d84a42', font: { size: 9 }, padding: 3 } },
          recover: { type: 'line', yMin: Number(account.thresholdRecover), yMax: Number(account.thresholdRecover), borderColor: '#f0a12b', borderWidth: 1, borderDash: [5, 4], label: { display: true, content: `恢复值 ${money(account.thresholdRecover)}`, position: 'end', backgroundColor: 'rgba(255,255,255,.84)', color: '#c67d17', font: { size: 9 }, padding: 3 } },
        },
      },
    },
  }), [account.thresholdLow, account.thresholdRecover]);

  if (!account) {
    return <main className="workspace glass-surface workspace-empty"><Wallet size={34} /><h2>选择一个上游账号</h2><p>余额、转换公式和事件闭环会显示在这里。</p></main>;
  }

  const testFormula = async () => {
    setTesting(true);
    try {
      const result = await api.testFormula(testRaw, formula);
      setTestResult(result.convertedCny);
      pushToast('公式有效，转换结果已更新', 'success');
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setTesting(false);
    }
  };

  const lowPct = Math.min(100, (account.thresholdLow / Math.max(account.thresholdRecover * 1.6, 1)) * 100);
  const recoverPct = Math.min(100, (account.thresholdRecover / Math.max(account.thresholdRecover * 1.6, 1)) * 100);

  return (
    <main className="workspace glass-surface" key={account.id}>
      <header className="account-header">
        <div className="account-identity">
          <i className={`status-dot large ${account.status}`} />
          <div><span className="workspace-eyebrow">{upstream?.name || '未命名上游'}</span><h1>{account.name}</h1><p><span>{platformLabel(account.type)}</span><b />{account.region}<b />账户 ID: {account.id.slice(0, 12)}…</p></div>
        </div>
        <div className="account-header-actions">
          <span className={`connection-badge ${account.status}`}>{account.status === 'error' ? '连接异常' : '连接正常'}</span>
          <span className="last-sync">最后同步：{relativeTime(account.lastSyncAt)}</span>
          <button className="icon-button" onClick={() => onRefresh(account.id)} disabled={busy} title="立即同步"><ArrowClockwise size={18} className={busy ? 'spin' : ''} /></button>
          <button className="icon-button" onClick={() => onEdit(account)} title="编辑账号"><PencilSimple size={18} /></button>
          <button className="icon-button" aria-label="更多操作"><DotsThreeVertical size={18} /></button>
        </div>
      </header>

      {account.lastError && <div className="inline-error">{account.lastError}</div>}

      <section className="balance-strip">
        <div className="metric-block">
          <span>原始余额 ({account.rawUnit})</span>
          <strong>{compactNumber(account.rawBalance)}</strong>
          <small>采集于 {relativeTime(account.lastSyncAt)}</small>
        </div>
        <div className="metric-block formula-metric">
          <span>转换公式</span>
          <button className="formula-chip" onClick={() => onEdit(account)}><code>{account.formula}</code><PencilSimple size={15} /><CheckCircle size={17} weight="fill" /></button>
          <small>变量 x 为原始余额</small>
        </div>
        <div className="metric-block converted-metric">
          <span>折算人民币 (CNY)</span>
          <strong>{money(account.convertedCny)}</strong>
          <small>= {compactNumber(account.rawBalance)} → CNY</small>
          {Number(account.dailyBurnRate) > 0 && <small className="burn-note">日均消耗约 {money(account.dailyBurnRate)}/天{Number.isFinite(account.depletionEtaDays) ? ` · 预计 ${account.depletionEtaDays} 天后低于阈值` : ''}</small>}
        </div>
        <div className="metric-block threshold-metric">
          <span>告警阈值 (CNY)</span>
          <div className="threshold-values"><label>低阈值<strong>{money(account.thresholdLow)}</strong></label><label>恢复值<strong>{money(account.thresholdRecover)}</strong></label></div>
          <div className="threshold-track"><i style={{ left: `${lowPct}%` }} /><i className="recover" style={{ left: `${recoverPct}%` }} /></div>
        </div>
      </section>

      <section className="chart-section">
        <header className="section-header">
          <div><h2>余额趋势</h2><span>历史折算人民币余额</span></div>
          <div className="chart-actions">
            <div className="segmented-control">
              {[7, 30, 90].map((days) => <button key={days} className={range === days ? 'active' : ''} onClick={() => setRange(days)}>{days} 天</button>)}
            </div>
            <button className="icon-button"><CalendarBlank size={17} /></button>
          </div>
        </header>
        <div className="chart-wrap">
          <Line data={lineData} options={lineOptions} />
        </div>
      </section>

      <section className="formula-tester">
        <header><div><h2>公式测试</h2><p>输入任意原始余额，实时检查折算结果。</p></div><Flask size={20} /></header>
        <div className="tester-grid">
          <label><span>原始余额 ({account.rawUnit})</span><input type="number" value={testRaw} onChange={(event) => setTestRaw(event.target.value)} /></label>
          <label className="formula-input"><span>转换公式</span><input value={formula} onChange={(event) => setFormula(event.target.value)} /><Copy size={15} /></label>
          <div className="test-arrow"><LinkSimple size={19} /></div>
          <div className="test-result"><span>折算后 (CNY)</span><strong>{money(testResult)}</strong></div>
          <button className="secondary-button" onClick={testFormula} disabled={testing}>{testing ? '测试中' : '重新测试'}</button>
        </div>
        {account.demo && <button className="demo-recharge" onClick={() => onRecharge(account.id)}><Wallet size={16} /> 模拟手动充值并完成恢复检测</button>}
      </section>
    </main>
  );
}
