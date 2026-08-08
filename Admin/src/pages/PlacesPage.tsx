import { MapPin, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiRequest, formatDate } from '../api/client';
import { PageState } from '../components/PageState';
import { useApiData } from '../hooks/useApiData';
import styles from './DataPage.module.css';

interface Place { id: string; name: string; categoryCode: string; longitude: string; latitude: string; address: string | null; externalSource: string | null; updatedAt: string }

export function PlacesPage() {
  const places = useApiData<Place[]>('/api/v1/admin/places');
  const [params] = useSearchParams();
  const [query, setQuery] = useState(params.get('search') ?? '');
  const [showCreate, setShowCreate] = useState(false);
  const filtered = useMemo(() => (places.data ?? []).filter((place) => `${place.name} ${place.address ?? ''}`.toLowerCase().includes(query.toLowerCase())), [places.data, query]);
  return <div className={styles.page}>
    <header className={styles.heading}><div><p>地点主数据</p><h1>地点与路线</h1><span>高德 POI 与 EazyPath 无障碍证据分层存储，地图来源不等于无障碍认证。</span></div><button className={styles.primaryButton} onClick={() => setShowCreate(true)}><Plus size={18} />新增地点</button></header>
    <div className={styles.toolbar}><label className={styles.search}><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索地点或地址" /></label><button className={styles.secondaryButton} onClick={() => void places.reload()}><RefreshCw size={17} />刷新</button></div>
    <section className={styles.card}><PageState loading={places.loading} error={places.error} empty={!places.loading && filtered.length === 0} onRetry={places.reload} />{!places.loading && !places.error && filtered.length > 0 && <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>地点</th><th>类别</th><th>来源</th><th>地址</th><th>坐标</th><th>更新时间</th></tr></thead><tbody>{filtered.map((place) => <tr key={place.id}><td><strong>{place.name}</strong><br/><code>{place.id}</code></td><td><span className={styles.chip}>{place.categoryCode}</span></td><td>{place.externalSource ?? '管理员'}</td><td>{place.address ?? '—'}</td><td>{Number(place.longitude).toFixed(5)}, {Number(place.latitude).toFixed(5)}</td><td>{formatDate(place.updatedAt)}</td></tr>)}</tbody></table></div>}</section>
    {showCreate && <CreatePlaceDrawer onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); void places.reload(); }} />}
  </div>;
}

function CreatePlaceDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [error, setError] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setError(null); const form = new FormData(event.currentTarget);
    try { await apiRequest('/api/v1/admin/places', { method: 'POST', body: JSON.stringify({ name: form.get('name'), category_code: form.get('category'), longitude: Number(form.get('longitude')), latitude: Number(form.get('latitude')), address: form.get('address') || undefined }) }); onCreated(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败'); }
    finally { setSaving(false); }
  };
  return <div className={styles.drawer} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className={styles.drawerPanel} aria-modal="true" role="dialog" aria-labelledby="create-place"><div className={styles.drawerHeader}><div><MapPin /><h2 id="create-place">新增真实地点</h2><p className={styles.muted}>请从现场或官方来源核对坐标，不要录入演示地点。</p></div><button className={styles.iconButton} onClick={onClose} aria-label="关闭"><X /></button></div><form className={styles.form} onSubmit={submit}><label>地点名称<input name="name" required maxLength={160} /></label><label>类别代码<input name="category" required placeholder="hotel / dining / station" /></label><label>经度<input name="longitude" required type="number" step="0.0000001" min="-180" max="180" /></label><label>纬度<input name="latitude" required type="number" step="0.0000001" min="-90" max="90" /></label><label>地址<textarea name="address" maxLength={1000} /></label>{error && <div className={styles.error}>{error}</div>}<div className={styles.formActions}><button type="button" className={styles.secondaryButton} onClick={onClose}>取消</button><button className={styles.primaryButton} disabled={saving}>{saving ? '保存中…' : '保存地点'}</button></div></form></aside></div>;
}
