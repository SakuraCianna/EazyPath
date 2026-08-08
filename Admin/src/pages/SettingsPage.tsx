import { Database, HardDrive, Radio, Server, ShieldCheck } from 'lucide-react';
import { PageState } from '../components/PageState';
import { useApiData } from '../hooks/useApiData';
import styles from './SettingsPage.module.css';

interface SystemData { environment: string; public_urls: Record<string,string>; models: Record<string,string>; media: Record<string,unknown>; events: Record<string,unknown>; voice: Record<string,unknown>; queue: Record<string,unknown> }

export function SettingsPage() {
  const system = useApiData<SystemData>('/api/v1/admin/system');
  if (system.loading || system.error || !system.data) return <PageState loading={system.loading} error={system.error} onRetry={system.reload}/>;
  const sections = [
    { title: '运行环境', icon: Server, data: { environment: system.data.environment, ...system.data.public_urls } },
    { title: 'Qwen 模型', icon: Radio, data: system.data.models },
    { title: '本地媒体', icon: HardDrive, data: system.data.media },
    { title: '队列与事件', icon: Database, data: { ...system.data.queue, ...system.data.events } },
    { title: '语音会话', icon: ShieldCheck, data: system.data.voice },
  ];
  return <div className={styles.page}><header><p>只读部署视图</p><h1>系统设置</h1><span>敏感密钥、密码和实际目录不会在浏览器中返回；修改请通过部署环境变量并重启服务。</span></header><section className={styles.grid}>{sections.map(({ title, icon: Icon, data }) => <article key={title}><div className={styles.title}><Icon/><h2>{title}</h2></div><dl>{Object.entries(data).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{formatSetting(value)}</dd></div>)}</dl></article>)}</section></div>;
}

function formatSetting(value: unknown) { if (typeof value === 'boolean') return value ? '是' : '否'; if (typeof value === 'number') return new Intl.NumberFormat('zh-CN').format(value); return String(value ?? '—'); }
