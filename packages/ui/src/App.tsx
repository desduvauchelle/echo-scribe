import { useEffect, useState } from 'react';
import { rpcClient } from './rpc-client.ts';

export function App() {
  const [pingMessage, setPingMessage] = useState<string | null>(null);
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpcClient.connect();

    rpcClient
      .call('system.ping', {})
      .then((res) => setPingMessage(res.message))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Ping failed: ${message}`);
      });

    const unsubscribe = rpcClient.subscribe('core.status', (payload) => {
      setUptimeSec(payload.uptimeSec);
    });

    return () => {
      unsubscribe();
      rpcClient.disconnect();
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-10 max-w-sm w-full space-y-4">
        <h1 className="text-xl font-semibold text-gray-900">Echo Scribe</h1>

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}

        <div className="space-y-2">
          <p className="text-sm text-gray-500">
            Core says:{' '}
            <span className="font-medium text-gray-900">
              {pingMessage ?? 'waiting…'}
            </span>
          </p>

          <p className="text-sm text-gray-500">
            Uptime:{' '}
            <span className="font-medium text-gray-900">
              {uptimeSec !== null ? `${uptimeSec}s` : 'waiting…'}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
