import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Eye,
  FileWarning,
  Image as ImageIcon,
  MapPin,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRoundCheck,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiBlobRequest, ApiClientError, apiRequest, formatDate } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { PageState } from '../components/PageState';
import { useApiData } from '../hooks/useApiData';
import { useModalDialog } from '../hooks/useModalDialog';
import type {
  AppealReviewItem,
  ObservationReviewDetail,
  ObservationReviewItem,
  ObservationStatus,
  Paginated,
  VerificationReviewItem,
  VerificationReviewStatus,
} from '../types/reviews';
import styles from './ReviewsPage.module.css';

type QueueKind = 'observations' | 'appeals' | 'verifications';
const pageSize = 30;

const queueOptions: Array<{ id: QueueKind; label: string; hint: string; icon: typeof ShieldCheck; permission: string }> = [
  { id: 'observations', label: '现场证据', hint: '审核结构化观测与脱敏图片', icon: ShieldCheck, permission: 'reviews.read' },
  { id: 'appeals', label: '用户申诉', hint: '处理驳回后的说明与补充', icon: UserRoundCheck, permission: 'reviews.read' },
  { id: 'verifications', label: 'AI 验真', hint: '复核模型结构化判断', icon: Bot, permission: 'verifications.read' },
];

export function ReviewsPage() {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const requestedQueue = parseQueue(params.get('queue'));
  const availableQueues = queueOptions.filter((item) => hasPermission(item.permission));
  const queue = availableQueues.some((item) => item.id === requestedQueue) ? requestedQueue : availableQueues[0]?.id;
  const [notice, setNotice] = useState<string | null>(null);
  const selectQueue = (next: QueueKind) => {
    setParams(next === 'observations' ? {} : { queue: next });
    setNotice(null);
  };

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>证据治理中枢</p>
          <h1>审核工作台</h1>
          <span>所有结论都基于真实观测、申诉或模型记录；冲突时要求刷新，不覆盖其他管理员的决定。</span>
        </div>
        <div className={styles.heroSignal}><span /><strong>隐私访问已审计</strong><small>原图不进入管理端</small></div>
      </header>

      <nav className={styles.queueTabs} aria-label="审核队列">
        {availableQueues.map(({ id, label, hint, icon: Icon }) => (
          <button key={id} className={queue === id ? styles.activeTab : ''} onClick={() => selectQueue(id)} aria-current={queue === id ? 'page' : undefined}>
            <span className={styles.tabIcon}><Icon aria-hidden="true" /></span>
            <span><strong>{label}</strong><small>{hint}</small></span>
          </button>
        ))}
      </nav>

      {notice && <div className={styles.notice} role="status"><CheckCircle2 />{notice}</div>}
      {!queue && <PageState error="当前管理员没有审核队列读取权限" />}
      {queue === 'observations' && <ObservationQueue onNotice={setNotice} />}
      {queue === 'appeals' && <AppealQueue onNotice={setNotice} />}
      {queue === 'verifications' && <VerificationQueue onNotice={setNotice} />}
    </div>
  );
}

function ObservationQueue({ onNotice }: { onNotice: (value: string) => void }) {
  const [status, setStatus] = useState<ObservationStatus>('pending');
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = useApiData<Paginated<ObservationReviewItem>>(`/api/v1/admin/reviews/observations?status=${status}&limit=${pageSize}&offset=${offset}`);
  const filtered = useMemo(() => (rows.data?.items ?? []).filter((item) => `${item.placeName} ${item.featureName} ${item.id}`.toLowerCase().includes(query.toLowerCase())), [query, rows.data]);
  const reload = async () => { await rows.reload(); };
  return (
    <section className={styles.workspace} aria-labelledby="observation-queue-title">
      <QueueToolbar title="现场证据队列" count={rows.data?.total} query={query} onQuery={setQuery} onReload={reload}>
        <label className={styles.selectLabel}>状态
          <select value={status} onChange={(event) => { setStatus(event.target.value as ObservationStatus); setOffset(0); }}>
            <option value="pending">待审核</option><option value="approved">已批准</option><option value="rejected">已驳回</option><option value="withdrawn">已撤回</option>
          </select>
        </label>
      </QueueToolbar>
      <QueueTableState loading={rows.loading} error={rows.error} empty={!rows.loading && filtered.length === 0} reload={reload}>
        <div className={styles.cardList}>
          {filtered.map((item) => (
            <button className={styles.reviewCard} key={item.id} onClick={() => setSelectedId(item.id)}>
              <span className={styles.cardLeading}><MapPin /></span>
              <span className={styles.cardBody}>
                <span className={styles.cardTitle}><strong>{item.placeName}</strong><StatusBadge value={item.moderationStatus} /></span>
                <span className={styles.featureName}>{item.featureName}</span>
                <span className={styles.cardMeta}><span>{formatValue(item.value)}</span><span>版本 {item.moderationVersion}</span><span>{formatDate(item.updatedAt)}</span></span>
              </span>
              <span className={styles.grade} aria-label={`证据等级 ${item.evidenceGrade}`}>{item.evidenceGrade}</span>
            </button>
          ))}
        </div>
      </QueueTableState>
      <Pagination offset={offset} total={rows.data?.total ?? 0} onChange={setOffset} />
      {selectedId && <ObservationPanel observationId={selectedId} onClose={() => setSelectedId(null)} onSaved={async () => { setSelectedId(null); await reload(); onNotice('现场证据审核结论已保存'); }} />}
    </section>
  );
}

function AppealQueue({ onNotice }: { onNotice: (value: string) => void }) {
  const [status, setStatus] = useState('active');
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AppealReviewItem | null>(null);
  const statusQuery = status === 'active' ? '' : `&status=${status}`;
  const rows = useApiData<Paginated<AppealReviewItem>>(`/api/v1/admin/reviews/appeals?limit=${pageSize}&offset=${offset}${statusQuery}`);
  const filtered = useMemo(() => (rows.data?.items ?? []).filter((item) => `${item.placeName} ${item.featureName} ${item.message}`.toLowerCase().includes(query.toLowerCase())), [query, rows.data]);
  return (
    <section className={styles.workspace} aria-labelledby="appeal-queue-title">
      <QueueToolbar title="用户申诉队列" count={rows.data?.total} query={query} onQuery={setQuery} onReload={rows.reload}>
        <label className={styles.selectLabel}>状态
          <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}>
            <option value="active">待处理</option><option value="open">新申诉</option><option value="in_review">补充中</option><option value="resolved">已重新受理</option><option value="rejected">已驳回</option>
          </select>
        </label>
      </QueueToolbar>
      <QueueTableState loading={rows.loading} error={rows.error} empty={!rows.loading && filtered.length === 0} reload={rows.reload}>
        <div className={styles.cardList}>
          {filtered.map((item) => (
            <button className={styles.reviewCard} key={item.id} onClick={() => setSelected(item)}>
              <span className={`${styles.cardLeading} ${styles.appealLeading}`}><FileWarning /></span>
              <span className={styles.cardBody}>
                <span className={styles.cardTitle}><strong>{item.placeName}</strong><StatusBadge value={item.status} /></span>
                <span className={styles.featureName}>{item.featureName}</span>
                <span className={styles.appealExcerpt}>{item.message}</span>
                <span className={styles.cardMeta}><span>观测版本 {item.moderationVersion}</span><span>截止 {formatDate(item.expiresAt)}</span></span>
              </span>
            </button>
          ))}
        </div>
      </QueueTableState>
      <Pagination offset={offset} total={rows.data?.total ?? 0} onChange={setOffset} />
      {selected && <AppealPanel appeal={selected} onClose={() => setSelected(null)} onSaved={async () => { setSelected(null); await rows.reload(); onNotice('用户申诉处理结论已保存'); }} />}
    </section>
  );
}

function VerificationQueue({ onNotice }: { onNotice: (value: string) => void }) {
  const [status, setStatus] = useState<VerificationReviewStatus>('unreviewed');
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<VerificationReviewItem | null>(null);
  const rows = useApiData<Paginated<VerificationReviewItem>>(`/api/v1/admin/reviews/verifications?status=${status}&limit=${pageSize}&offset=${offset}`);
  const filtered = useMemo(() => (rows.data?.items ?? []).filter((item) => `${item.scene} ${item.modelName} ${item.riskLevel}`.toLowerCase().includes(query.toLowerCase())), [query, rows.data]);
  return (
    <section className={styles.workspace} aria-labelledby="verification-queue-title">
      <QueueToolbar title="AI 验真复核" count={rows.data?.total} query={query} onQuery={setQuery} onReload={rows.reload}>
        <label className={styles.selectLabel}>状态
          <select value={status} onChange={(event) => { setStatus(event.target.value as VerificationReviewStatus); setOffset(0); }}>
            <option value="unreviewed">未复核</option><option value="confirmed">已确认</option><option value="flagged">已标记</option>
          </select>
        </label>
      </QueueToolbar>
      <QueueTableState loading={rows.loading} error={rows.error} empty={!rows.loading && filtered.length === 0} reload={rows.reload}>
        <div className={styles.cardList}>
          {filtered.map((item) => (
            <button className={styles.reviewCard} key={item.id} onClick={() => setSelected(item)}>
              <span className={`${styles.cardLeading} ${styles.aiLeading}`}><Bot /></span>
              <span className={styles.cardBody}>
                <span className={styles.cardTitle}><strong>{sceneLabel(item.scene)}</strong><StatusBadge value={item.adminReviewStatus} /></span>
                <span className={styles.featureName}>{item.modelName} · {item.promptVersion}</span>
                <span className={styles.cardMeta}><span>风险 {item.riskLevel}</span><span>置信度 {item.confidence ?? '未知'}</span><span>{formatDate(item.createdAt)}</span></span>
              </span>
              <span className={item.temporaryMediaDeletedAt ? styles.deletedProof : styles.deletedMissing}>{item.temporaryMediaDeletedAt ? '临时图已删' : '待确认删除'}</span>
            </button>
          ))}
        </div>
      </QueueTableState>
      <Pagination offset={offset} total={rows.data?.total ?? 0} onChange={setOffset} />
      {selected && <VerificationPanel item={selected} onClose={() => setSelected(null)} onSaved={async () => { setSelected(null); await rows.reload(); onNotice('AI 验真人工复核结论已保存'); }} />}
    </section>
  );
}

function ObservationPanel({ observationId, onClose, onSaved }: { observationId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const detail = useApiData<ObservationReviewDetail>(`/api/v1/admin/reviews/observations/${observationId}`);
  const { hasPermission } = useAuth();
  const [decision, setDecision] = useState<'approve' | 'reject' | 'request_changes'>('approve');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail.data) return;
    setSaving(true); setError(null);
    try {
      await apiRequest(`/api/v1/admin/reviews/observations/${observationId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason, expected_version: detail.data.observation.moderationVersion }),
      });
      await onSaved();
    } catch (cause) { setError(reviewError(cause)); }
    finally { setSaving(false); }
  };
  return (
    <ReviewPanel title="现场证据详情" subtitle={detail.data?.observation.placeName ?? '正在读取…'} onClose={onClose}>
      <PageState loading={detail.loading} error={detail.error} onRetry={detail.reload} />
      {detail.data && <>
        <div className={styles.detailHero}><div><span>{detail.data.observation.featureName}</span><strong>{formatValue(detail.data.observation.value)}</strong><small>{detail.data.observation.featureUnit ?? detail.data.observation.featureValueType}</small></div><StatusBadge value={detail.data.observation.moderationStatus} /></div>
        <InfoGrid items={[
          ['证据等级', detail.data.observation.evidenceGrade],
          ['粗粒度位置证明', detail.data.observation.locationProofPassed ? detail.data.observation.locationDistanceBucket ?? '已通过' : '未验证'],
          ['提交者状态', detail.data.observation.contributorStatus ?? '账户已删除'],
          ['历史通过贡献', String(detail.data.observation.contributorAcceptedCount ?? 0)],
          ['现场时间', formatDate(detail.data.observation.observedAt)],
          ['当前版本', String(detail.data.observation.moderationVersion)],
        ]} />
        <section className={styles.detailSection}><h3><ImageIcon />脱敏证据图片</h3><p>图片仅在点击后按需读取，每次成功访问都会写入审计日志。</p><MediaGallery media={detail.data.media} canRead={hasPermission('media.read')} /></section>
        <section className={styles.detailSection}><h3><Clock3 />反馈与处理历史</h3>{detail.data.feedback.length === 0 ? <p>暂无用户申诉或补充请求。</p> : <div className={styles.timeline}>{detail.data.feedback.map((item) => <article key={item.id}><span /><div><strong>{feedbackLabel(item.feedbackType)} · {item.status}</strong><p>{item.message}</p><small>{formatDate(item.createdAt)}{item.expiresAt ? ` · 截止 ${formatDate(item.expiresAt)}` : ''}</small></div></article>)}</div>}</section>
        <DecisionForm title="记录审核结论" decision={decision} onDecision={(value) => setDecision(value as typeof decision)} options={[
          ['approve', '批准为 C 级社区证据'], ['request_changes', '要求用户补充资料'], ['reject', '驳回并开启 30 天申诉期'],
        ]} reason={reason} onReason={setReason} error={error} saving={saving} disabled={!hasPermission('reviews.decide')} onSubmit={submit} />
      </>}
    </ReviewPanel>
  );
}

function AppealPanel({ appeal, onClose, onSaved }: { appeal: AppealReviewItem; onClose: () => void; onSaved: () => Promise<void> }) {
  const detail = useApiData<ObservationReviewDetail>(`/api/v1/admin/reviews/observations/${appeal.observationId}`);
  const { hasPermission } = useAuth();
  const [decision, setDecision] = useState<'reopen' | 'reject' | 'request_more'>('reopen');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      await apiRequest(`/api/v1/admin/reviews/appeals/${appeal.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({
          decision,
          reason,
          expected_observation_version: appeal.moderationVersion,
          expected_appeal_updated_at: appeal.updatedAt,
        }),
      });
      await onSaved();
    } catch (cause) { setError(reviewError(cause)); }
    finally { setSaving(false); }
  };
  return <ReviewPanel title="用户申诉" subtitle={`${appeal.placeName} · ${appeal.featureName}`} onClose={onClose}>
    <div className={styles.appealMessage}><UserRoundCheck /><div><span>用户说明</span><p>{appeal.message}</p><small>提交 {formatDate(appeal.createdAt)} · 响应截止 {formatDate(appeal.expiresAt)}</small></div></div>
    <PageState loading={detail.loading} error={detail.error} onRetry={detail.reload} />
    {detail.data && <>
      <div className={styles.detailHero}><div><span>原观测值</span><strong>{formatValue(detail.data.observation.value)}</strong><small>版本 {appeal.moderationVersion}</small></div><StatusBadge value={appeal.status} /></div>
      <section className={styles.detailSection}><h3><ImageIcon />仍在申诉期内的证据</h3><MediaGallery media={detail.data.media} canRead={hasPermission('media.read')} /></section>
    </>}
    <DecisionForm title="处理申诉" decision={decision} onDecision={(value) => setDecision(value as typeof decision)} options={[
      ['reopen', '重新受理并回到审核队列'], ['request_more', '要求补充更多资料'], ['reject', '维持驳回结论'],
    ]} reason={reason} onReason={setReason} error={error} saving={saving} disabled={!hasPermission('reviews.decide')} onSubmit={submit} />
  </ReviewPanel>;
}

function VerificationPanel({ item, onClose, onSaved }: { item: VerificationReviewItem; onClose: () => void; onSaved: () => Promise<void> }) {
  const { hasPermission } = useAuth();
  const [decision, setDecision] = useState<'confirm' | 'flag'>('confirm');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      await apiRequest(`/api/v1/admin/reviews/verifications/${item.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason, expected_updated_at: item.updatedAt }),
      });
      await onSaved();
    } catch (cause) { setError(reviewError(cause)); }
    finally { setSaving(false); }
  };
  return <ReviewPanel title="AI 验真复核" subtitle={sceneLabel(item.scene)} onClose={onClose}>
    <div className={styles.aiSummary}>
      <span className={styles.aiOrb}><Bot /></span>
      <div><span>{item.modelName} · {item.promptVersion}</span><strong>风险 {item.riskLevel} · 置信度 {item.confidence ?? '未知'}</strong><small>{item.temporaryMediaDeletedAt ? `临时图片已于 ${formatDate(item.temporaryMediaDeletedAt)} 删除` : '临时图片删除时间尚未记录'}</small></div>
    </div>
    <section className={styles.detailSection}><h3><Eye />模型结构化结果</h3><pre className={styles.json}>{JSON.stringify(item.result, null, 2)}</pre></section>
    <DecisionForm title="记录人工复核" decision={decision} onDecision={(value) => setDecision(value as typeof decision)} options={[
      ['confirm', '确认结构化结果可供参考'], ['flag', '标记风险或结果异常'],
    ]} reason={reason} onReason={setReason} error={error} saving={saving} disabled={!hasPermission('reviews.decide')} onSubmit={submit} />
  </ReviewPanel>;
}

function ReviewPanel({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useModalDialog(onClose);
  return <div className={styles.scrim} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside ref={dialogRef} tabIndex={-1} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="review-panel-title">
      <header className={styles.panelHeader}><div><p>安全审核视图</p><h2 id="review-panel-title">{title}</h2><span>{subtitle}</span></div><button onClick={onClose} aria-label="关闭审核详情"><X /></button></header>
      <div className={styles.panelContent}>{children}</div>
    </aside>
  </div>;
}

function QueueToolbar({ title, count, query, onQuery, onReload, children }: { title: string; count?: number; query: string; onQuery: (value: string) => void; onReload: () => void | Promise<void>; children: ReactNode }) {
  return <div className={styles.toolbar}><div><h2>{title}</h2><span>{count === undefined ? '读取中' : `${count} 条真实记录`}</span></div><label className={styles.search}><Search /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="筛选地点、字段或 ID" aria-label={`筛选${title}`} /></label>{children}<button className={styles.iconButton} onClick={() => void onReload()} aria-label="刷新队列"><RefreshCw /></button></div>;
}

function QueueTableState({ loading, error, empty, reload, children }: { loading: boolean; error: string | null; empty: boolean; reload: () => void | Promise<void>; children: ReactNode }) {
  if (loading || error || empty) return <div className={styles.stateCard}><PageState loading={loading} error={error} empty={empty} onRetry={() => void reload()} /></div>;
  return children;
}

function DecisionForm({ title, decision, onDecision, options, reason, onReason, error, saving, disabled, onSubmit }: { title: string; decision: string; onDecision: (value: string) => void; options: Array<[string, string]>; reason: string; onReason: (value: string) => void; error: string | null; saving: boolean; disabled: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className={styles.decisionForm} onSubmit={onSubmit}><div><h3>{title}</h3><p>理由至少 6 个字符，将写入审计日志并可能展示给提交用户。</p></div><label>结论<select value={decision} onChange={(event) => onDecision(event.target.value)} disabled={disabled}>{options.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>审核理由<textarea value={reason} onChange={(event) => onReason(event.target.value)} required minLength={6} maxLength={2000} disabled={disabled} placeholder="说明可见事实、对象匹配情况和需要补充的内容" /></label>{error && <div className={styles.formError} role="alert"><AlertTriangle />{error}</div>}{disabled && <div className={styles.permissionNote}>当前角色没有 reviews.decide 权限，只能查看。</div>}<button type="submit" disabled={saving || disabled || reason.trim().length < 6}>{saving ? '正在保存…' : '确认并写入审计'}</button></form>;
}

function MediaGallery({ media, canRead }: { media: ObservationReviewDetail['media']; canRead: boolean }) {
  const [images, setImages] = useState<Record<string, { url?: string; loading?: boolean; error?: string }>>({});
  const objectUrls = useRef<string[]>([]);
  const mounted = useRef(true);
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllers.current.forEach((controller) => controller.abort());
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);
  const load = async (id: string) => {
    setImages((current) => ({ ...current, [id]: { loading: true } }));
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const blob = await apiBlobRequest(`/api/v1/admin/reviews/media/${id}/content`, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      objectUrls.current.push(url);
      setImages((current) => ({ ...current, [id]: { url } }));
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setImages((current) => ({ ...current, [id]: { error: cause instanceof Error ? cause.message : '读取失败' } }));
    } finally {
      controllers.current.delete(controller);
    }
  };
  if (media.length === 0) return <p>该观测没有关联图片。</p>;
  return <div className={styles.mediaGrid}>{media.map((item) => { const image = images[item.id]; const unavailable = Boolean(item.deletedAt) || item.status === 'deleted'; return <article key={item.id} className={styles.mediaCard}>{image?.url ? <img src={image.url} alt="用户确认脱敏后的现场证据" /> : <div className={styles.mediaPlaceholder}><ImageIcon /><span>{unavailable ? '图片已按保留期删除' : `${Math.round(item.byteSize / 1024)} KB · ${item.mimeType}`}</span>{!unavailable && canRead && <button onClick={() => void load(item.id)} disabled={image?.loading}>{image?.loading ? '读取中…' : '查看脱敏图片'}</button>}{!canRead && <small>当前角色无 media.read 权限</small>}{image?.error && <small className={styles.mediaError}>{image.error}</small>}</div>}<footer><StatusBadge value={item.status} /><span>{item.redactionConfirmed ? '已确认脱敏' : '脱敏未确认'}</span></footer></article>; })}</div>;
}

function InfoGrid({ items }: { items: Array<[string, string]> }) { return <dl className={styles.infoGrid}>{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>; }
function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (offset: number) => void }) { if (total <= pageSize) return null; return <div className={styles.pagination}><span>第 {Math.floor(offset / pageSize) + 1} 页，共 {Math.ceil(total / pageSize)} 页</span><button onClick={() => onChange(Math.max(0, offset - pageSize))} disabled={offset === 0} aria-label="上一页"><ChevronLeft /></button><button onClick={() => onChange(offset + pageSize)} disabled={offset + pageSize >= total} aria-label="下一页"><ChevronRight /></button></div>; }
function StatusBadge({ value }: { value: string }) { const tone = /approved|resolved|confirmed|completed|linked/.test(value) ? styles.good : /reject|flag|fail|deleted|withdrawn/.test(value) ? styles.bad : /open|pending|review|unreviewed|appeal/.test(value) ? styles.waiting : styles.neutral; return <span className={`${styles.statusBadge} ${tone}`}>{statusLabel(value)}</span>; }
function parseQueue(value: string | null): QueueKind { return value === 'appeals' || value === 'verifications' ? value : 'observations'; }
function statusLabel(value: string) { return ({ pending: '待审核', approved: '已批准', rejected: '已驳回', withdrawn: '已撤回', open: '新申诉', in_review: '补充中', resolved: '已重新受理', unreviewed: '未复核', confirmed: '已确认', flagged: '已标记', linked: '已关联', appeal_hold: '申诉保留', deleted: '已删除' } as Record<string, string>)[value] ?? value; }
function sceneLabel(value: string) { return ({ entrance: '入口通行', restroom: '无障碍卫生间', elevator: '电梯与垂直通行', ramp: '坡道', parking: '无障碍停车位' } as Record<string, string>)[value] ?? value; }
function feedbackLabel(value: string) { return ({ appeal: '用户申诉', supplement_request: '补充请求', correction: '纠错', withdrawal: '撤回' } as Record<string, string>)[value] ?? value; }
function formatValue(value: unknown) { if (typeof value === 'boolean') return value ? '有 / 可用' : '无 / 不可用'; if (typeof value === 'number' || typeof value === 'string') return String(value); return value ? JSON.stringify(value) : '未知'; }
function reviewError(cause: unknown) { if (cause instanceof ApiClientError && cause.status === 409) return `${cause.message} 请关闭详情并刷新队列后重试。`; return cause instanceof Error ? cause.message : '保存审核结论失败'; }
