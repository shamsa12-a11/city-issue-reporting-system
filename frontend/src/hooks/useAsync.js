import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs `load()` when `deps` change and tracks { data, error, loading }.
 * Results of an outdated call are ignored, so fast filter changes never show
 * stale data. `reload()` runs it again; `setData` allows optimistic updates.
 */
export default function useAsync(load, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const callId = useRef(0);

  const run = useCallback(() => {
    const id = ++callId.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    return Promise.resolve()
      .then(load)
      .then((data) => {
        if (id === callId.current) setState({ data, error: null, loading: false });
      })
      .catch((error) => {
        if (id === callId.current) setState({ data: null, error, loading: false });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  const setData = useCallback((updater) => setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater })), []);
  return { ...state, reload: run, setData };
}
