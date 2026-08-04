import { useCallback, useEffect, useState } from "react";

export function useAsyncData<T>(loader: (signal: AbortSignal) => Promise<T>, dependencies: readonly unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    loader(controller.signal)
      .then((value) => { if (!controller.signal.aborted) setData(value); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The request failed."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
    // loader is expected to be stable or deliberately keyed through dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, ...dependencies]);

  return { data, setData, error, loading, reload };
}
