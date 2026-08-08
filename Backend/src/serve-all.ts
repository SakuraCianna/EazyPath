import { spawn, type ChildProcess } from 'node:child_process';

const children = new Set<ChildProcess>();
let shuttingDown = false;

async function runOnce(script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} 启动步骤失败: code=${code ?? 'null'}, signal=${signal ?? 'none'}`));
    });
  });
}

function startLongRunning(script: string): void {
  const child = spawn(process.execPath, [script], { stdio: 'inherit' });
  children.add(child);
  child.once('error', (error) => {
    console.error(JSON.stringify({ level: 'error', event: 'process.spawn_failed', script, message: error.message }));
    void shutdown('SPAWN_ERROR', 1);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(JSON.stringify({ level: 'error', event: 'process.unexpected_exit', script, code, signal }));
      void shutdown('CHILD_EXIT', code ?? 1);
    }
  });
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(JSON.stringify({ level: 'info', event: 'process_manager.shutdown', signal }));
  for (const child of children) child.kill('SIGTERM');
  await Promise.all([...children].map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve()))));
  process.exit(exitCode);
}

async function main(): Promise<void> {
  await runOnce('dist/scripts/migrate.js');
  await runOnce('dist/scripts/bootstrap-admin.js');
  startLongRunning('dist/index.js');
  startLongRunning('dist/worker.js');
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '容器启动失败');
  process.exit(1);
});
