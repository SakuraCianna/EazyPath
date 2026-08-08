import { ExternalLink, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { apiRequest, formatDate } from '../api/client';
import { PageState } from '../components/PageState';
import { useApiData } from '../hooks/useApiData';
import styles from './DataPage.module.css';

interface PlatformConfig { id: string; platform: string; capability: string; mode: string; appUriTemplate: string | null; webUrlTemplate: string | null; allowedHosts: string[]; enabled: boolean; verifiedAt: string | null }

export function PlatformLinksPage() {
  const configs = useApiData<PlatformConfig[]>('/api/v1/admin/platform-links');
  const [editing, setEditing] = useState<Record<string, PlatformConfig>>({});
  const [message, setMessage] = useState<string | null>(null);
  const update = (row: PlatformConfig, next: Partial<PlatformConfig>) => setEditing((current) => ({ ...current, [row.id]: { ...(current[row.id] ?? row), ...next } }));
  const save = async (row: PlatformConfig) => {
    const value = editing[row.id] ?? row; setMessage(null);
    try { await apiRequest('/api/v1/admin/platform-links', { method: 'POST', body: JSON.stringify({ platform: value.platform, capability: value.capability, mode: value.mode, app_uri_template: value.appUriTemplate || undefined, web_url_template: value.webUrlTemplate || undefined, allowed_hosts: value.allowedHosts, enabled: value.enabled }) }); setMessage(`${row.platform} 配置已保存`); void configs.reload(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : '保存失败'); }
  };
  return <div className={styles.page}><header className={styles.heading}><div><p>公开能力白名单</p><h1>平台配置</h1><span>仅启用经过官方文档或商务授权验证的入口；未授权 DeepLink 保持 unavailable。</span></div><button className={styles.secondaryButton} onClick={() => void configs.reload()}><RefreshCw size={17}/>刷新</button></header>{message && <div className={styles.error} role="status">{message}</div>}<section className={styles.card}><PageState loading={configs.loading} error={configs.error} empty={configs.data?.length === 0} onRetry={configs.reload}/>{configs.data && configs.data.length > 0 && <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>平台 / 能力</th><th>模式</th><th>Web URL</th><th>白名单 Host</th><th>已启用</th><th>验证时间</th><th>操作</th></tr></thead><tbody>{configs.data.map((row) => { const value = editing[row.id] ?? row; return <tr key={row.id}><td><strong>{row.platform}</strong><br/><span className={styles.muted}>{row.capability}</span></td><td><select value={value.mode} onChange={(event) => update(row, { mode: event.target.value })}><option value="app_uri">App URI</option><option value="web">Web</option><option value="clipboard">剪贴板</option><option value="authorized_api">授权 API</option><option value="unavailable">不可用</option></select></td><td>{value.webUrlTemplate ? <a href={value.webUrlTemplate} target="_blank" rel="noreferrer">官方入口 <ExternalLink size={13}/></a> : '—'}</td><td>{value.allowedHosts.join(', ') || '—'}</td><td><label><input type="checkbox" checked={value.enabled} onChange={(event) => update(row, { enabled: event.target.checked })}/> {value.enabled ? '是' : '否'}</label></td><td>{formatDate(row.verifiedAt)}</td><td><button className={styles.rowButton} onClick={() => void save(row)}><Save size={14}/>保存</button></td></tr>; })}</tbody></table></div>}</section><div className={styles.toolbar}><ShieldCheck size={20}/><span className={styles.muted}>高德仅提供普通路线入口；12306 为官方服务说明；滴滴未授权时不生成 Scheme；携程和美团仅打开公开移动网页。</span></div></div>;
}
