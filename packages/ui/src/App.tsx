import { useState, useEffect } from 'react';
import { rpcClient } from './rpc-client.ts';
import { SettingsPage } from './pages/Settings.tsx';

type Page = 'main' | 'settings';

export function App() {
  const [page, setPage] = useState<Page>('main');
  const [pingResult, setPingResult] = useState<string | null>(null);
  const [uptime, setUptime] = useState<number | null>(null);

  useEffect(() => {
    rpcClient.connect();
    rpcClient
      .call('system.ping', {})
      .then((r) => setPingResult(r.message))
      .catch(() => setPingResult('error'));

    const unsubscribe = rpcClient.subscribe('core.status', (payload) => {
      setUptime(payload.uptimeSec);
    });
    return unsubscribe;
  }, []);

  return (
    <div className="min-h-screen bg-white">
      <nav className="flex items-center justify-between px-6 py-3 border-b">
        <span className="font-semibold">Echo Scribe</span>
        <button
          onClick={() => setPage(page === 'settings' ? 'main' : 'settings')}
          className="text-sm text-gray-600 hover:text-gray-900"
        >
          {page === 'settings' ? '<- Back' : 'Settings'}
        </button>
      </nav>

      <main className="p-6">
        {page === 'settings' ? (
          <SettingsPage />
        ) : (
          <div className="space-y-2">
            <p className="text-lg">
              Core says: <strong>{pingResult ?? '...'}</strong>
            </p>
            {uptime !== null && <p className="text-sm text-gray-500">Uptime: {uptime}s</p>}
          </div>
        )}
      </main>
    </div>
  );
}
