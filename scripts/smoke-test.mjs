// Backward-compatible entry point. The former ad-hoc smoke script could miss
// Socket.IO events and hang. M9 replaces it with the maintained integration
// suite, which owns its test server and has bounded event timeouts.
import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npmCommand, ['test'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

child.once('error', error => {
  console.error(`Could not start integration tests: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', code => {
  process.exitCode = code ?? 1;
});
