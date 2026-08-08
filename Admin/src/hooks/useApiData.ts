import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api/client';

export function useApiData<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await apiRequest<T>(path)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '加载失败'); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}
