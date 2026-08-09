import { RefreshCw, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatDate } from '../api/client';
import { PageState } from '../components/PageState';
import { useApiData } from '../hooks/useApiData';
import { useModalDialog } from '../hooks/useModalDialog';
import styles from './DataPage.module.css';

type PageKind = 'users' | 'tasks' | 'media' | 'audit';
type Row = Record<string, unknown>;
interface Column { label: string; key: string; type?: 'date' | 'status' | 'bytes' }
interface PageConfig { eyebrow: string; title: string; description: string; endpoint: string; columns: Column[] }

const configs: Record<PageKind, PageConfig> = {
  users: { eyebrow: '匿名安装账户', title: '用户', description: 'P0 仅管理 App 生成 GUID 的匿名安装账户，不读取硬件设备号或强制手机号。', endpoint: '/api/v1/admin/installations', columns: [{ label: '安装账户 ID', key: 'id' }, { label: '安装 GUID', key: 'installationGuid' }, { label: '状态', key: 'status', type: 'status' }, { label: '通过贡献', key: 'acceptedContributionCount' }, { label: '最近活动', key: 'lastSeenAt', type: 'date' }, { label: '创建时间', key: 'createdAt', type: 'date' }] },
  tasks: { eyebrow: 'Agent 编排', title: 'Agent 任务', description: 'PostgreSQL 是任务事实来源，BullMQ 负责执行与重试。', endpoint: '/api/v1/admin/tasks', columns: [{ label: '任务 ID', key: 'id' }, { label: '输入类型', key: 'inputType' }, { label: '状态', key: 'status', type: 'status' }, { label: '失败码', key: 'failureCode' }, { label: '时区', key: 'clientTimezone' }, { label: '创建时间', key: 'createdAt', type: 'date' }, { label: '完成时间', key: 'completedAt', type: 'date' }] },
  media: { eyebrow: '本地受保护存储', title: '本地媒体', description: '仅显示已确认脱敏的社区证据元数据；文件目录不直接暴露给浏览器。', endpoint: '/api/v1/admin/media', columns: [{ label: '媒体 ID', key: 'id' }, { label: '类型', key: 'mimeType' }, { label: '大小', key: 'byteSize', type: 'bytes' }, { label: '状态', key: 'status', type: 'status' }, { label: '已确认脱敏', key: 'redactionConfirmed' }, { label: '关联时间', key: 'linkedAt', type: 'date' }, { label: '过期时间', key: 'expiresAt', type: 'date' }] },
  audit: { eyebrow: '不可静默修改', title: '审计日志', description: '管理员审核、账户、平台配置和社区共识变化均可追溯。', endpoint: '/api/v1/admin/audit-events', columns: [{ label: '时间', key: 'createdAt', type: 'date' }, { label: '操作者', key: 'actorType' }, { label: '动作', key: 'action' }, { label: '目标类型', key: 'targetType' }, { label: '目标 ID', key: 'targetId' }, { label: '理由', key: 'reason' }, { label: '请求 ID', key: 'requestId' }] },
};

export function OperationalListPage({ kind }: { kind: PageKind }) {
  const config = configs[kind];
  const rows = useApiData<Row[]>(config.endpoint);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Row | null>(null);
  const filtered = useMemo(() => (rows.data ?? []).filter((row) => JSON.stringify(row).toLowerCase().includes(query.toLowerCase())), [rows.data, query]);
  return <div className={styles.page}>
    <header className={styles.heading}><div><p>{config.eyebrow}</p><h1>{config.title}</h1><span>{config.description}</span></div></header>
    <div className={styles.toolbar}><label className={styles.search}><Search size={18}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选当前列表" /></label><button className={styles.secondaryButton} onClick={() => void rows.reload()}><RefreshCw size={17}/>刷新</button></div>
    <section className={styles.card}><PageState loading={rows.loading} error={rows.error} empty={!rows.loading && filtered.length === 0} onRetry={rows.reload}/>{filtered.length > 0 && <div className={styles.tableWrap}><table className={styles.table}><thead><tr>{config.columns.map((column) => <th key={column.key}>{column.label}</th>)}<th>详情</th></tr></thead><tbody>{filtered.map((row, index) => <tr key={String(row.id ?? index)}>{config.columns.map((column) => <td key={column.key}>{renderValue(row[column.key], column.type)}</td>)}<td><button className={styles.rowButton} onClick={() => setSelected(row)}>查看</button></td></tr>)}</tbody></table></div>}</section>
    {selected && <DetailDrawer title={config.title} row={selected} onClose={() => setSelected(null)} />}
  </div>;
}

function renderValue(value: unknown, type?: Column['type']) {
  if (type === 'date') return formatDate(value);
  if (type === 'bytes' && typeof value === 'number') return `${(value / 1024).toFixed(1)} KB`;
  if (type === 'status') return <span className={`${styles.chip} ${String(value).includes('fail') || String(value).includes('reject') ? styles.danger : String(value).includes('complete') || String(value).includes('active') || String(value).includes('accepted') ? styles.success : styles.pending}`}>{String(value ?? '—')}</span>;
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return <span className={styles.muted}>结构化数据</span>;
  return String(value);
}

function DetailDrawer({ title, row, onClose }: { title: string; row: Row; onClose: () => void }) {
  const dialogRef = useModalDialog(onClose);
  return <div className={styles.drawer} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={dialogRef} tabIndex={-1} className={styles.drawerPanel} role="dialog" aria-modal="true" aria-label={`${title}详情`}><div className={styles.drawerHeader}><div><h2>{title}详情</h2><p className={styles.muted}>原始 API 结构，仅管理会话可查看。</p></div><button className={styles.iconButton} onClick={onClose} aria-label="关闭"><X/></button></div><pre className={styles.json}>{JSON.stringify(row, null, 2)}</pre></aside></div>;
}
