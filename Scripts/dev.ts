import { spawn } from 'bun';

const vite = spawn({
  cmd: ['bun', 'run', '--cwd', 'packages/ui', 'dev'],
  stdout: 'inherit',
  stderr: 'inherit',
});

const core = spawn({
  cmd: ['bun', 'run', 'apps/core-runtime/src/main.ts'],
  stdout: 'inherit',
  stderr: 'inherit',
});

process.on('SIGINT', () => {
  vite.kill();
  core.kill();
  process.exit(0);
});

await Promise.all([vite.exited, core.exited]);
