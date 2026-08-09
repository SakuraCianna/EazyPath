import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/client';

export function useApiData<T>(path: string, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestGeneration = useRef(0);
  const reload = useCallback(async () => {
    const generation = ++requestGeneration.current;
    if (!enabled) {
      setData(null); setError(null); setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    try {
      const result = await apiRequest<T>(path);
      if (generation === requestGeneration.current) setData(result);
    }
    catch (reason) {
      if (generation === requestGeneration.current) setError(reason instanceof Error ? reason.message : '加载失败');
    }
    finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [enabled, path]);
  useEffect(() => {
    void reload();
    return () => { requestGeneration.current += 1; };
  }, [reload]);
  return { data, error, loading, reload };
}
