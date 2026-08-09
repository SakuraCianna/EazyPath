import { AlertTriangle, Ban, CheckCircle2, Clock3, Image, MapPinCheck, RefreshCw, RotateCcw, Search, ShieldQuestion, Users, X } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { apiBlobRequest, apiRequest, formatDate } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { PageState } from '../components/PageState';
import { useApiData } from '../hooks/useApiData';
import { useModalDialog } from '../hooks/useModalDialog';
import styles from './CommunityReviewsPage.module.css';

type ReviewStatus = 'pending_review' | 'community_consensus' | 'conflicting' | 'admin_rejected' | 'cancelled' | 'reopened';
type AdminAction = 'reopen' | 'reject' | 'cancel';
interface ReviewTask {
  id: string; placeId: string; placeName: string; placeAddress: string | null; targetType: string; targetId: string;
  featureKey: string; featureName: string; status: ReviewStatus; reason: string; consensusOutcome: string | null;
  consensusSnapshot: ConsensusSnapshot | null; locationRadiusMeters: number; closesAt: string | null;
  resolutionReason: string | null; resolvedAt: string | null; supersededByTaskId: string | null;
  createdAt: string; updatedAt: string; observationValue: unknown; observationGrade: string | null;
  observationFreshness: string | null; observationExpiresAt: string | null; observationObservedAt: string | null;
  voteCount: number; locatedVoteCount: number; mediaVoteCount: number;
}
interface ConsensusSnapshot {
  presentWeight?: number; absentWeight?: number; directionalWeight?: number; dominantRatio?: number;
  distinctInstallations?: number; snapshot?: { version?: string; minimumInstallations?: number; dominanceRatio?: number };
}
interface ReviewPage {
  items: ReviewTask[]; total: number; page: number; pageSize: number;
  summary: { pending: number; conflicting: number; consensus: number; resolved: number };
}
interface Vote {
  answer: 'present' | 'absent' | 'unknown'; mediaId: string | null; baseWeight: string; finalWeight: string; hasMedia: boolean;
  locationProofPassed: boolean; locationDistanceBucket: string | null; suspended: boolean; createdAt: string; updatedAt: string;
}
interface ReviewDetail { task: ReviewTask; votes: Vote[] }

export function CommunityReviewsPage() {
  const { hasPermission } = useAuth();
  const canDecide = hasPermission('reviews.decide');
  const canReadMedia = hasPermission('media.read');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | ReviewStatus>('all');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query.trim());
  useEffect(() => setPage(1), [deferredQuery, status]);
  const path = useMemo(() => {
    const search = new URLSearchParams({ page: String(page), page_size: '25' });
    if (deferredQuery) search.set('q', deferredQuery);
    if (status !== 'all') search.set('status', status);
    return `/api/v1/admin/community-reviews?${search}`;
  }, [deferredQuery, page, status]);
  const reviews = useApiData<ReviewPage>(path);
  const summary = reviews.data?.summary ?? { pending: 0, conflicting: 0, consensus: 0, resolved: 0 };
  const totalPages = Math.max(1, Math.ceil((reviews.data?.total ?? 0) / (reviews.data?.pageSize ?? 25)));
  const saved = async (message: string) => {
    setSelectedId(null);
    await reviews.reload();
    setNotice(message);
  };

  return <div className={styles.page}>
    <header className={styles.hero}><div><p>社区证据治理</p><h1>独立复核与冲突处置</h1><span>共识由版本化规则计算；管理员不能凭主观把匿名证据认证为 A 级，只能驳回、作废或开启全新轮次。</span></div><div className={styles.heroMark}><Users /><span>匿名投票</span><strong>不展示安装标识</strong></div></header>
    <section className={styles.metrics} aria-label="社区复核统计">
      <Metric label="等待更多复核" value={summary.pending} icon={<Clock3 />} tone="pending" />
      <Metric label="需要管理员" value={summary.conflicting} icon={<AlertTriangle />} tone="danger" />
      <Metric label="社区已达共识" value={summary.consensus} icon={<CheckCircle2 />} tone="success" />
      <Metric label="运营已结案" value={summary.resolved} icon={<ShieldQuestion />} tone="neutral" />
    </section>
    {notice && <div className={styles.notice} role="status"><CheckCircle2 />{notice}</div>}
    <div className={styles.toolbar}>
      <label className={styles.search}><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索地点、地址或特征字段" aria-label="搜索社区复核" /></label>
      <label className={styles.filter}>状态<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="all">全部轮次</option><option value="conflicting">信息冲突</option><option value="pending_review">待更多复核</option><option value="community_consensus">已达共识</option><option value="admin_rejected">管理员驳回</option><option value="reopened">已重新发起</option><option value="cancelled">已作废</option></select></label>
      <button className={styles.refresh} onClick={() => void reviews.reload()}><RefreshCw />刷新</button>
    </div>
    <section className={styles.card}>
      <PageState loading={reviews.loading} error={reviews.error} empty={!reviews.loading && (reviews.data?.items.length ?? 0) === 0} onRetry={reviews.reload} />
      {(reviews.data?.items.length ?? 0) > 0 && <div className={styles.tableWrap}><table><thead><tr><th>地点与特征</th><th>轮次状态</th><th>票数与现场证据</th><th>共识方向</th><th>关联观测</th><th>更新时间</th><th>详情</th></tr></thead><tbody>{reviews.data?.items.map((task) => <tr key={task.id}>
        <td><strong>{task.placeName}</strong><small>{task.featureName} · {task.featureKey}</small></td>
        <td><Status value={task.status} /><small>{reasonLabel(task.reason)}</small></td>
        <td><strong>{task.voteCount} 票已提交</strong><small>{task.mediaVoteCount} 票附图 · {task.locatedVoteCount} 票位置通过</small></td>
        <td>{task.consensusOutcome ? answerLabel(task.consensusOutcome) : '尚无确定方向'}<small>{ratioLabel(task.consensusSnapshot)}</small></td>
        <td><strong>{task.observationGrade ?? '—'} 级 · {task.observationFreshness ?? '—'}</strong><small>{formatObservationValue(task.observationValue)}</small></td>
        <td>{formatDate(task.updatedAt)}</td>
        <td><button className={styles.open} onClick={() => setSelectedId(task.id)}>{canDecide && ['pending_review', 'conflicting', 'admin_rejected'].includes(task.status) ? '处置' : '查看'}</button></td>
      </tr>)}</tbody></table></div>}
      {reviews.data && reviews.data.total > reviews.data.pageSize && <nav className={styles.pagination} aria-label="社区复核分页"><span>共 {reviews.data.total} 轮 · 第 {page} / {totalPages} 页</span><div><button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>上一页</button><button onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages}>下一页</button></div></nav>}
    </section>
    {selectedId && <ReviewPanel taskId={selectedId} canDecide={canDecide} canReadMedia={canReadMedia} onClose={() => setSelectedId(null)} onSaved={saved} />}
  </div>;
}

function Metric({ label, value, icon, tone }: { label: string; value: number; icon: ReactNode; tone: string }) {
  return <article className={styles[tone]}><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div></article>;
}

function ReviewPanel({ taskId, canDecide, canReadMedia, onClose, onSaved }: { taskId: string; canDecide: boolean; canReadMedia: boolean; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const dialogRef = useModalDialog(onClose);
  const detail = useApiData<ReviewDetail>(`/api/v1/admin/community-reviews/${taskId}`);
  const [action, setAction] = useState<AdminAction | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const task = detail.data?.task;
  const options = task ? actionOptions(task.status) : [];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!task || !action || !confirmed || reason.trim().length < 6) return;
    setSaving(true); setError(null);
    try {
      await apiRequest(`/api/v1/admin/community-reviews/${task.id}/decision`, {
        method: 'POST', body: JSON.stringify({ action, expected_updated_at: task.updatedAt, reason }),
      });
      await onSaved(action === 'reopen' ? '已创建全新的独立复核轮次' : action === 'reject' ? '该轮复核已驳回，关联证据保持未知' : '异常复核任务已作废');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '社区复核处置失败'); }
    finally { setSaving(false); }
  };
  return <div className={styles.scrim} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={dialogRef} tabIndex={-1} className={styles.panel} role="dialog" aria-modal="true" aria-label="社区复核详情">
    <header><div><p>社区复核轮次</p><h2>{task?.placeName ?? '正在读取…'}</h2><span>{task ? `${task.featureName} · ${task.id}` : '从 PostgreSQL 读取任务和匿名投票'}</span></div><button onClick={onClose} aria-label="关闭"><X /></button></header>
    <PageState loading={detail.loading} error={detail.error} empty={!detail.loading && !task} onRetry={detail.reload} />
    {task && <>
      <section className={styles.taskSummary}><div><Status value={task.status} /><strong>{task.featureName}</strong><span>{task.placeAddress ?? '地址未知'} · 现场半径 {task.locationRadiusMeters} 米</span></div><div><small>关联观测</small><strong>{task.observationGrade ?? '—'} 级 / {task.observationFreshness ?? '—'}</strong><span>{formatObservationValue(task.observationValue)} · 观测于 {formatDate(task.observationObservedAt)}</span></div></section>
      <ConsensusCard snapshot={task.consensusSnapshot} outcome={task.consensusOutcome} />
      <section className={styles.votes}><header><div><h3>匿名投票构成</h3><p>仅展示回答、权重和证据完整度，不返回安装账户或设备标识。</p></div><strong>{detail.data?.votes.length ?? 0} 票</strong></header>{(detail.data?.votes.length ?? 0) === 0 ? <p className={styles.emptyVotes}>尚无用户完成本轮复核。</p> : <div className={styles.voteGrid}>{detail.data?.votes.map((vote, index) => <article key={`${vote.updatedAt}-${index}`}><div><StatusDot answer={vote.answer} /><strong>{answerLabel(vote.answer)}</strong><span>最终权重 {Number(vote.finalWeight).toFixed(2)}</span></div><footer>{vote.hasMedia && <span><Image />脱敏图</span>}{vote.locationProofPassed && <span><MapPinCheck />位置通过</span>}{vote.suspended && <span><Ban />暂停计权</span>}<time>{formatDate(vote.updatedAt)}</time></footer><VoteMedia vote={vote} canRead={canReadMedia} /></article>)}</div>}</section>
      {task.resolutionReason && <section className={styles.resolution}><strong>运营结案记录</strong><p>{task.resolutionReason}</p><span>{formatDate(task.resolvedAt)}{task.supersededByTaskId ? ` · 新轮次 ${task.supersededByTaskId}` : ''}</span></section>}
      {canDecide && options.length > 0 && <form className={styles.decision} onSubmit={submit}><header><h3>管理员处置</h3><p>处置不修改历史投票；重新发起会创建空白新轮次。</p></header><div className={styles.actionGrid}>{options.map((item) => <label key={item.action} className={action === item.action ? styles.selectedAction : ''}><input type="radio" name="action" value={item.action} checked={action === item.action} onChange={() => { setAction(item.action); setConfirmed(false); }} /><span>{item.icon}<strong>{item.label}</strong><small>{item.description}</small></span></label>)}</div><label className={styles.reason}>处置理由<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={6} maxLength={1000} placeholder="说明判断依据、异常原因或重新征集目的" /></label><label className={styles.confirm}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已核对共识快照和投票构成，确认执行所选操作</label>{error && <div className={styles.error} role="alert">{error}</div>}<button className={styles.submit} disabled={saving || !action || !confirmed || reason.trim().length < 6}>{saving ? '正在处置…' : '确认处置'}</button></form>}
    </>}
  </aside></div>;
}

function VoteMedia({ vote, canRead }: { vote: Vote; canRead: boolean }) {
  const [state, setState] = useState<{ loading?: boolean; url?: string; error?: string }>({});
  const urlRef = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    controllerRef.current?.abort();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);
  if (!vote.hasMedia) return null;
  if (!vote.mediaId) return <div className={styles.voteMediaUnavailable}>图片已按保留期删除，仅保留提交时证据完整度。</div>;
  const load = async () => {
    setState({ loading: true });
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const blob = await apiBlobRequest(`/api/v1/admin/community-reviews/media/${vote.mediaId}/content`, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setState({ url });
    } catch (cause) {
      if (!controller.signal.aborted) setState({ error: cause instanceof Error ? cause.message : '读取图片失败' });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };
  if (state.url) return <img className={styles.voteMedia} src={state.url} alt="用户确认脱敏后的社区复核证据" />;
  return <div className={styles.voteMediaAction}>{canRead ? <button type="button" onClick={() => void load()} disabled={state.loading}>{state.loading ? '读取中…' : '查看脱敏图片'}</button> : <span>当前角色无 media.read 权限</span>}{state.error && <small role="alert">{state.error}</small>}</div>;
}

function ConsensusCard({ snapshot, outcome }: { snapshot: ConsensusSnapshot | null; outcome: string | null }) {
  const present = snapshot?.presentWeight ?? 0;
  const absent = snapshot?.absentWeight ?? 0;
  const total = Math.max(snapshot?.directionalWeight ?? present + absent, 0.01);
  return <section className={styles.consensus}><header><div><h3>版本化共识快照</h3><p>规则版本 {snapshot?.snapshot?.version ?? '尚未生成'} · 方向占优门槛 {Math.round((snapshot?.snapshot?.dominanceRatio ?? .75) * 100)}%</p></div><strong>{outcome ? answerLabel(outcome) : '未形成结论'}</strong></header><div className={styles.weightBar} aria-label={`确认存在权重 ${present}，确认不存在权重 ${absent}`}><span style={{ width: `${present / total * 100}%` }} /><i style={{ width: `${absent / total * 100}%` }} /></div><footer><span>存在 {present.toFixed(2)}</span><span>不存在 {absent.toFixed(2)}</span><span>占优 {Math.round((snapshot?.dominantRatio ?? 0) * 100)}%</span><span>{snapshot?.distinctInstallations ?? 0} 个独立账户</span></footer></section>;
}

function actionOptions(status: ReviewStatus) {
  const items: Array<{ action: AdminAction; label: string; description: string; icon: ReactNode }> = [];
  if (status === 'conflicting' || status === 'admin_rejected') items.push({ action: 'reopen', label: '重新发起', description: '保留本轮并创建空白新轮次', icon: <RotateCcw /> });
  if (status === 'pending_review' || status === 'conflicting') items.push({ action: 'reject', label: '驳回本轮', description: '关联事实保持未知并退出当前推荐', icon: <Ban /> }, { action: 'cancel', label: '作废异常任务', description: '仅关闭错误或重复任务', icon: <X /> });
  return items;
}

function Status({ value }: { value: ReviewStatus }) { return <span className={`${styles.status} ${styles[value]}`}>{statusLabel(value)}</span>; }
function StatusDot({ answer }: { answer: Vote['answer'] }) { return <span className={`${styles.dot} ${styles[answer]}`} aria-hidden="true" />; }
function statusLabel(value: ReviewStatus) { return ({ pending_review: '待更多复核', community_consensus: '社区已达共识', conflicting: '信息冲突', admin_rejected: '管理员驳回', cancelled: '已作废', reopened: '已重新发起' } as Record<ReviewStatus, string>)[value]; }
function answerLabel(value: string) { return ({ present: '确认仍存在', absent: '确认已不存在', unknown: '无法确认' } as Record<string, string>)[value] ?? value; }
function reasonLabel(value: string) { return ({ evidence_expired: '证据到期', evidence_conflict: '证据冲突', high_frequency: '高频查询', admin_reopened: '管理员重新征集' } as Record<string, string>)[value] ?? value; }
function ratioLabel(snapshot: ConsensusSnapshot | null) { return snapshot ? `占优 ${Math.round((snapshot.dominantRatio ?? 0) * 100)}% · 规则 ${snapshot.snapshot?.version ?? '未知'}` : '尚无共识快照'; }
function formatObservationValue(value: unknown) { if (value === null || value === undefined) return '无结构化值'; if (typeof value === 'object') return JSON.stringify(value); if (typeof value === 'boolean') return value ? '是' : '否'; return String(value); }
