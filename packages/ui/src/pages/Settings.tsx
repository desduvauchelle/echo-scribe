import { useState, useEffect } from 'react';
import { rpcClient } from '../rpc-client.ts';

export function SettingsPage() {
  const [hotkeyBinding, setHotkeyBinding] = useState('cmd+shift+space');
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    rpcClient
      .call('system.getSettings', {})
      .then((s) => {
        setHotkeyBinding(s.hotkeyBinding);
      })
      .catch(() => {});
  }, []);

  const startRecording = () => {
    setRecording(true);

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      const parts: string[] = [];
      if (e.metaKey) parts.push('cmd');
      if (e.ctrlKey) parts.push('ctrl');
      if (e.shiftKey) parts.push('shift');
      if (e.altKey) parts.push('opt');
      const key = e.key.toLowerCase();
      if (!['meta', 'control', 'shift', 'alt'].includes(key)) {
        parts.push(key === ' ' ? 'space' : key);
        const binding = parts.join('+');
        setHotkeyBinding(binding);
        setRecording(false);
        saveBinding(binding);
        window.removeEventListener('keydown', handleKeyDown);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
  };

  const saveBinding = async (binding: string) => {
    setStatus('saving');
    try {
      await rpcClient.call('system.updateSettings', { patch: { hotkeyBinding: binding } });
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="p-6 max-w-md">
      <h2 className="text-lg font-semibold mb-4">Voice-to-text shortcut</h2>
      <div className="flex items-center gap-3">
        <div className="font-mono bg-gray-100 px-3 py-1.5 rounded border text-sm min-w-[140px]">
          {recording ? 'Press a key combo...' : hotkeyBinding}
        </div>
        <button
          onClick={startRecording}
          disabled={recording}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {recording ? 'Recording...' : 'Record new...'}
        </button>
      </div>
      {status === 'saved' && <p className="text-sm text-green-600 mt-2">Saved</p>}
      {status === 'error' && <p className="text-sm text-red-600 mt-2">Failed to save</p>}
    </div>
  );
}
