import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
// Runs only as a test-worker preload. Observe and fail any launcher attempt, before side effects.
for (const api of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[api] = () => { process.send?.({ stage: 'sdk-child-attempt', api }); throw new Error('SDK_CHILD_PROCESS_FORBIDDEN'); };
}
childProcess.ChildProcess.prototype.spawn = () => { process.send?.({ stage: 'sdk-child-attempt', api: 'ChildProcess.spawn' }); throw new Error('SDK_CHILD_PROCESS_FORBIDDEN'); };
syncBuiltinESMExports();
process.send?.({ stage: 'sdk-launch-monitor-ready' });
