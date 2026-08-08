import { AlertTriangle, Bot, CheckCircle2, Clock3, Database, ExternalLink, Image, MapPinned, RefreshCw, Server, Users } from 'lucide-react';
import { formatDate } from '../api/client';
import { PageState } from '../components/PageState';
import { useApiData } from '../hooks/useApiData';
import styles from './DashboardPage.module.css';

interface DashboardData {
  region: { label: string };
  metrics: { pending_evidence: number; pending_reviews: number; failed_tasks: number; expiring_evidence: number };
  queue: Record<string, number>;
  sources: Array<{ id: string; label: string; configured: boolean }>;
}

interface ReviewRow {
  observation: { id: string; evidenceSource: string; moderationStatus: string; evidenceGrade: string; createdAt: string; expiresAt?: string };
  placeName: string;
}

const metricDefinitions = [
  { key: 'pending_evidence', label: '待审核证据', icon: Image, tone: 'primary' },
  { key: 'pending_reviews', label: '等待社区复核', icon: Users, tone: 'secondary' },
  { key: 'failed_tasks', label: '异常任务', icon: AlertTriangle, tone: 'danger' },
  { key: 'expiring_evidence', label: '7 天内过期', icon: Clock3, tone: 'warning' },
] as const;

export function DashboardPage() {
  const dashboard = useApiData<DashboardData>('/api/v1/admin/dashboard');
  const reviews = useApiData<ReviewRow[]>('/api/v1/admin/reviews');
  if (dashboard.loading || dashboard.error || !dashboard.data) return <PageState loading={dashboard.loading} error={dashboard.error} onRetry={dashboard.reload} />;
  const data = dashboard.data;
  return (
    <div className={styles.page}>
      <header className={styles.heading}><div><p>实时运营</p><h1>运营总览</h1><span>只显示 PostgreSQL、Redis/BullMQ 与已配置数据源返回的真实状态。</span></div><button onClick={() => { void dashboard.reload(); void reviews.reload(); }}><RefreshCw size={18} />刷新</button></header>
      <section className={styles.metrics} aria-label="关键指标">
        {metricDefinitions.map(({ key, label, icon: Icon, tone }) => <article key={key} className={styles.metric}><span className={`${styles.metricIcon} ${styles[tone]}`}><Icon /></span><div><span>{label}</span><strong>{data.metrics[key]}</strong><small>当前数据库计数</small></div></article>)}
      </section>
      <section className={styles.mainGrid}>
        <article className={styles.coverage}>
          <div className={styles.sectionTitle}><div><MapPinned /><span><strong>江西无障碍证据覆盖</strong><small>地点与观测图层</small></span></div><a href="/places">管理地点<ExternalLink size={16} /></a></div>
          <div className={styles.coverageEmpty}><div className={styles.mapGrid} aria-hidden="true" /><MapPinned /><strong>等待地点与证据数据</strong><span>接入高德地点并产生已审核观测后，这里将展示真实覆盖。不会绘制模拟标记。</span></div>
          <div className={styles.legend}><span><i className={styles.ramp} />坡道证据</span><span><i className={styles.elevator} />电梯证据</span><span><i className={styles.risk} />台阶风险</span></div>
        </article>
        <article className={styles.health}>
          <div className={styles.sectionTitle}><div><Server /><span><strong>数据源配置</strong><small>密钥值不会显示</small></span></div></div>
          <div className={styles.sourceList}>{data.sources.map((source) => <div key={source.id} className={styles.source}><span className={styles.sourceIcon}>{source.id === 'qwen' ? <Bot /> : source.id === 'postgresql' ? <Database /> : <Server />}</span><span><strong>{source.label}</strong><small>{source.id === 'redis_bullmq' ? '缓存与任务队列' : '生产数据源'}</small></span><span className={source.configured ? styles.ok : styles.missing}>{source.configured ? <><CheckCircle2 />已配置</> : '未配置'}</span></div>)}</div>
        </article>
      </section>
      <section className={styles.bottomGrid}>
        <article className={styles.tableCard}>
          <div className={styles.sectionTitle}><div><Image /><span><strong>证据审核队列</strong><small>最近提交的现场观测</small></span></div><a href="/reviews">查看全部<ExternalLink size={16} /></a></div>
          {reviews.loading || reviews.error || !reviews.data || reviews.data.length === 0 ? <PageState loading={reviews.loading} error={reviews.error} empty={reviews.data?.length === 0} onRetry={reviews.reload} /> : <div className={styles.tableScroll}><table><thead><tr><th>地点</th><th>来源</th><th>状态</th><th>等级</th><th>提交时间</th></tr></thead><tbody>{reviews.data.slice(0, 7).map((row) => <tr key={row.observation.id}><td>{row.placeName}</td><td>{row.observation.evidenceSource}</td><td><span className={styles.status}>{row.observation.moderationStatus}</span></td><td>{row.observation.evidenceGrade}</td><td>{formatDate(row.observation.createdAt)}</td></tr>)}</tbody></table></div>}
        </article>
        <article className={styles.queueCard}>
          <div className={styles.sectionTitle}><div><ListIcon /><span><strong>BullMQ 任务状态</strong><small>eazypath-agent-tasks</small></span></div></div>
          <dl>{['wait', 'active', 'delayed', 'failed', 'completed'].map((key) => <div key={key}><dt>{queueLabel(key)}</dt><dd className={key === 'failed' ? styles.failed : ''}>{data.queue[key] ?? 0}</dd></div>)}</dl>
        </article>
      </section>
    </div>
  );
}

function ListIcon() { return <span className={styles.queueGlyph}>Q</span>; }
function queueLabel(key: string) { return ({ wait: '等待中', active: '处理中', delayed: '延迟中', failed: '失败', completed: '已完成' } as Record<string, string>)[key] ?? key; }
