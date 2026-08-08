import { Inbox, RefreshCw, TriangleAlert } from 'lucide-react';
import styles from './PageState.module.css';

export function PageState({ loading, error, empty, onRetry }: { loading?: boolean; error?: string | null; empty?: boolean; onRetry?: () => void }) {
  if (loading) return <div className={styles.state} role="status"><span className={styles.spinner} />正在读取真实数据…</div>;
  if (error) return <div className={styles.state} role="alert"><TriangleAlert /><strong>加载失败</strong><span>{error}</span>{onRetry && <button onClick={onRetry}><RefreshCw size={17} />重试</button>}</div>;
  if (empty) return <div className={styles.state}><Inbox /><strong>暂无符合条件的数据</strong><span>系统不会使用演示数据填充这里。</span></div>;
  return null;
}
