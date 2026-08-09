import { AlertTriangle, Building2, CheckCircle2, GitMerge, MapPin, Pencil, Plus, RefreshCw, Search, ShieldOff, X } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiRequest, formatDate } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { PageState } from '../components/PageState';
import { useApiData } from '../hooks/useApiData';
import { useModalDialog } from '../hooks/useModalDialog';
import styles from './PlacesPage.module.css';

type PlaceStatus = 'active' | 'disabled' | 'merged';
interface Place {
  id: string;
  externalSource: string | null;
  externalId: string | null;
  name: string;
  categoryCode: string;
  longitude: string;
  latitude: string;
  address: string | null;
  status: PlaceStatus;
  mergedIntoPlaceId: string | null;
  mergedIntoPlaceName: string | null;
  adminOverrideAt: string | null;
  observationCount: number;
  approvedEvidenceCount: number;
  facilityCount: number;
  updatedAt: string;
}
interface PlacePage {
  items: Place[];
  total: number;
  page: number;
  pageSize: number;
  summary: { active: number; disabled: number; merged: number; evidence: number };
}
interface PlaceTarget { id: string; name: string; address: string | null; updatedAt: string }

export function PlacesPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('places.write');
  const [params] = useSearchParams();
  const routeSearch = params.get('search') ?? '';
  const [query, setQuery] = useState(routeSearch);
  const [status, setStatus] = useState<'all' | PlaceStatus>('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Place | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query.trim());
  useEffect(() => {
    setQuery(routeSearch);
    setPage(1);
  }, [routeSearch]);
  useEffect(() => setPage(1), [deferredQuery, status]);
  const listPath = useMemo(() => {
    const search = new URLSearchParams({ page: String(page), page_size: '25' });
    if (deferredQuery) search.set('q', deferredQuery);
    if (status !== 'all') search.set('status', status);
    return `/api/v1/admin/places?${search}`;
  }, [deferredQuery, page, status]);
  const places = useApiData<PlacePage>(listPath);
  const items = places.data?.items ?? [];
  const counts = places.data?.summary ?? { active: 0, disabled: 0, merged: 0, evidence: 0 };
  const totalPages = Math.max(1, Math.ceil((places.data?.total ?? 0) / (places.data?.pageSize ?? 25)));
  const saved = async (message: string) => {
    setSelected(null);
    await places.reload();
    setNotice(message);
  };

  return <div className={styles.page}>
    <header className={styles.hero}><div><p>地点主数据治理</p><h1>地点与证据覆盖</h1><span>高德 POI 与 EazyPath 无障碍证据分层存储；停用不会删除历史，合并会把证据迁移到 canonical 地点。</span></div>{canWrite && <button onClick={() => setSelected('new')}><Plus />新增真实地点</button>}</header>
    <section className={styles.metrics} aria-label="地点治理统计">
      <Metric label="启用地点" value={counts.active} icon={<MapPin />} />
      <Metric label="已停用" value={counts.disabled} icon={<ShieldOff />} />
      <Metric label="已合并" value={counts.merged} icon={<GitMerge />} />
      <Metric label="有效证据" value={counts.evidence} icon={<CheckCircle2 />} />
    </section>
    {notice && <div className={styles.notice} role="status"><CheckCircle2 />{notice}</div>}
    <div className={styles.toolbar}>
      <label className={styles.search}><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索地点、地址、类别或高德 ID" aria-label="搜索地点" /></label>
      <label className={styles.statusFilter}>状态<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="all">全部</option><option value="active">启用</option><option value="disabled">停用</option><option value="merged">已合并</option></select></label>
      <button className={styles.refresh} onClick={() => void places.reload()}><RefreshCw />刷新</button>
    </div>
    <section className={styles.card}>
      <PageState loading={places.loading} error={places.error} empty={!places.loading && items.length === 0} onRetry={places.reload} />
      {items.length > 0 && <div className={styles.tableWrap}><table><thead><tr><th>地点</th><th>状态</th><th>数据来源</th><th>证据 / 设施</th><th>坐标</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{items.map((place) => <tr key={place.id}>
        <td><strong>{place.name}</strong><small>{place.address ?? '地址未知'} · {place.categoryCode}</small></td>
        <td><Status value={place.status} /></td>
        <td>{place.externalSource ? <><strong>{place.externalSource}</strong><small>{place.externalId}{place.adminOverrideAt ? ' · 管理员覆盖' : ''}</small></> : <span>管理员录入</span>}</td>
        <td><strong>{place.approvedEvidenceCount} 条有效</strong><small>{place.observationCount} 条观测 · {place.facilityCount} 个设施</small></td>
        <td><code>{Number(place.longitude).toFixed(5)}, {Number(place.latitude).toFixed(5)}</code></td>
        <td>{formatDate(place.updatedAt)}</td>
        <td><button className={styles.manage} onClick={() => setSelected(place)}>{canWrite ? <><Pencil />管理</> : '查看'}</button></td>
      </tr>)}</tbody></table></div>}
      {places.data && places.data.total > places.data.pageSize && <nav className={styles.pagination} aria-label="地点列表分页"><span>共 {places.data.total} 条 · 第 {page} / {totalPages} 页</span><div><button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>上一页</button><button onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages}>下一页</button></div></nav>}
    </section>
    {selected && <PlacePanel place={selected} canWrite={canWrite} onClose={() => setSelected(null)} onSaved={saved} />}
  </div>;
}

function Metric({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return <article><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div></article>;
}

function PlacePanel({ place, canWrite, onClose, onSaved }: { place: Place | 'new'; canWrite: boolean; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const dialogRef = useModalDialog(onClose);
  const current = place === 'new' ? null : place;
  const [mode, setMode] = useState<'details' | 'merge'>('details');
  const [reason, setReason] = useState('');
  const [targetId, setTargetId] = useState('');
  const [targetQuery, setTargetQuery] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deferredTargetQuery = useDeferredValue(targetQuery.trim());
  const targetPath = useMemo(() => {
    const search = new URLSearchParams();
    if (deferredTargetQuery) search.set('q', deferredTargetQuery);
    if (current) search.set('exclude_place_id', current.id);
    return `/api/v1/admin/places/merge-targets?${search}`;
  }, [current, deferredTargetQuery]);
  const mergeTargets = useApiData<PlaceTarget[]>(targetPath, Boolean(current && mode === 'merge'));

  const saveFields = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setError(null);
    const form = new FormData(event.currentTarget);
    const body = {
      name: form.get('name'), category_code: form.get('category_code'), longitude: Number(form.get('longitude')),
      latitude: Number(form.get('latitude')), address: String(form.get('address') ?? '').trim() || null,
      reason: form.get('reason'), ...(current ? { expected_updated_at: current.updatedAt } : {}),
    };
    try {
      await apiRequest(current ? `/api/v1/admin/places/${current.id}` : '/api/v1/admin/places', { method: current ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      await onSaved(current ? '地点主数据已更新' : '真实地点已创建');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '地点保存失败'); }
    finally { setSaving(false); }
  };
  const setStatus = async () => {
    if (!current || reason.trim().length < 6) return;
    setSaving(true); setError(null);
    const nextStatus = current.status === 'active' ? 'disabled' : 'active';
    try {
      await apiRequest(`/api/v1/admin/places/${current.id}/status`, { method: 'POST', body: JSON.stringify({ status: nextStatus, expected_updated_at: current.updatedAt, reason }) });
      await onSaved(nextStatus === 'disabled' ? '地点已停用，历史证据继续保留' : '地点已重新启用');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '状态更新失败'); }
    finally { setSaving(false); }
  };
  const merge = async (event: FormEvent) => {
    event.preventDefault();
    const target = mergeTargets.data?.find((candidate) => candidate.id === targetId);
    if (!current || !target || !confirmed) return;
    setSaving(true); setError(null);
    try {
      await apiRequest(`/api/v1/admin/places/${current.id}/merge`, { method: 'POST', body: JSON.stringify({ target_place_id: target.id, expected_source_updated_at: current.updatedAt, expected_target_updated_at: target.updatedAt, reason }) });
      await onSaved(`“${current.name}”已合并到“${target.name}”`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '地点合并失败'); }
    finally { setSaving(false); }
  };

  return <div className={styles.scrim} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={dialogRef} tabIndex={-1} className={styles.panel} role="dialog" aria-modal="true" aria-label={current ? `管理地点 ${current.name}` : '新增真实地点'}>
    <header><div><p>{current ? current.categoryCode : '管理员录入'}</p><h2>{current?.name ?? '新增真实地点'}</h2><span>{current ? `${current.id} · ${statusLabel(current.status)}` : '请根据现场或可信官方来源核对名称和坐标'}</span></div><button onClick={onClose} aria-label="关闭"><X /></button></header>
    {current && canWrite && current.status !== 'merged' && <div className={styles.panelTabs}><button className={mode === 'details' ? styles.active : ''} onClick={() => setMode('details')}>编辑与状态</button><button className={mode === 'merge' ? styles.active : ''} onClick={() => setMode('merge')}><GitMerge />合并重复地点</button></div>}
    {current?.status === 'merged' ? <div className={styles.mergedCard}><GitMerge /><div><strong>该记录已合并</strong><p>canonical 地点：{current.mergedIntoPlaceName ?? current.mergedIntoPlaceId}</p><span>历史证据和设施已经迁移，来源 ID 仅用于旧链接解析和审计。</span></div></div>
      : mode === 'details' ? <form className={styles.form} onSubmit={saveFields}>
        {current?.externalSource && <div className={styles.sourceOverride}><Building2 /><span><strong>{current.adminOverrideAt ? '管理员覆盖已启用' : '编辑后将启用管理员覆盖'}</strong>高德仍会刷新来源时间，但不会静默覆盖管理员核对后的名称、类别、坐标和地址。</span></div>}
        <label>地点名称<input name="name" required maxLength={160} defaultValue={current?.name} disabled={!canWrite} /></label>
        <label>类别代码<input name="category_code" required maxLength={64} defaultValue={current?.categoryCode} placeholder="hotel / dining / station" disabled={!canWrite} /></label>
        <div className={styles.coordinateRow}><label>经度<input name="longitude" required type="number" step="0.0000001" min="-180" max="180" defaultValue={current?.longitude} disabled={!canWrite} /></label><label>纬度<input name="latitude" required type="number" step="0.0000001" min="-90" max="90" defaultValue={current?.latitude} disabled={!canWrite} /></label></div>
        <label>地址<textarea name="address" maxLength={1000} defaultValue={current?.address ?? ''} disabled={!canWrite} /></label>
        {canWrite && <label>操作理由<textarea name="reason" required minLength={6} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明数据来源、核对方式或变更原因" /></label>}
        {error && <div className={styles.error} role="alert">{error}</div>}
        {canWrite && <div className={styles.actions}>{current && <button type="button" className={current.status === 'active' ? styles.disable : styles.activate} onClick={() => void setStatus()} disabled={saving || reason.trim().length < 6}>{current.status === 'active' ? <><ShieldOff />停用地点</> : <><CheckCircle2 />重新启用</>}</button>}<button className={styles.save} disabled={saving || reason.trim().length < 6}>{saving ? '保存中…' : current ? '保存修改' : '创建地点'}</button></div>}
      </form> : <form className={styles.mergeForm} onSubmit={merge}>
        <div className={styles.warning}><AlertTriangle /><span><strong>合并会迁移全部下游数据</strong>单位、设施、现场观测、AI 验真、社区复核和位置证明都会改为目标地点；来源记录保留为只读重定向。</span></div>
        <label>搜索 canonical 目标<input value={targetQuery} onChange={(event) => { setTargetQuery(event.target.value); setTargetId(''); }} placeholder="输入地点名称、地址或高德 ID" /></label>
        <label>Canonical 目标地点<select value={targetId} onChange={(event) => setTargetId(event.target.value)} required disabled={mergeTargets.loading}><option value="">{mergeTargets.loading ? '正在查询启用地点…' : '请选择启用中的目标地点'}</option>{(mergeTargets.data ?? []).map((target) => <option key={target.id} value={target.id}>{target.name} · {target.address ?? target.id}</option>)}</select></label>
        {mergeTargets.error && <div className={styles.error} role="alert">{mergeTargets.error}</div>}
        <label>合并理由<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={6} maxLength={1000} placeholder="说明确认两条记录属于同一地点的依据" /></label>
        <label className={styles.confirm}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已核对来源和目标，确认迁移到所选 canonical 地点</label>
        {error && <div className={styles.error} role="alert">{error}</div>}
        <button className={styles.mergeButton} disabled={saving || !targetId || !confirmed || reason.trim().length < 6}>{saving ? '合并中…' : '确认合并地点'}</button>
      </form>}
  </aside></div>;
}

function Status({ value }: { value: PlaceStatus }) { return <span className={`${styles.status} ${styles[value]}`}>{statusLabel(value)}</span>; }
function statusLabel(value: PlaceStatus) { return value === 'active' ? '启用' : value === 'disabled' ? '已停用' : '已合并'; }
