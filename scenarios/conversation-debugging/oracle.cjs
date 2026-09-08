const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Keep imports and subject side effects away from retained evidence, and own
// cleanup outside the Python process so an early subject exit cannot skip it.
let scratch;
let result;
try {
  if (!process.env.TMPDIR) throw new Error('TMPDIR is required');
  const driver = path.join(__dirname, 'oracle.py');
  fs.accessSync(driver, fs.constants.R_OK);
  scratch = fs.mkdtempSync(path.join(process.env.TMPDIR, 'conversation-oracle-'));
  const output = path.join(scratch, 'output');
  fs.cpSync(process.cwd(), output, { recursive: true, dereference: false });
  result = spawnSync('python3', ['-I', driver], {
    cwd: output,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.error) throw result.error;
} catch (error) {
  process.stderr.write(`checker error: ${error.message}\n`);
  process.exitCode = 127;
} finally {
  if (scratch) {
    try { fs.rmSync(scratch, { recursive: true, force: true }); }
    catch (error) {
      process.stderr.write(`checker cleanup error: ${error.message}\n`);
      process.exitCode = 127;
    }
  }
}
if (process.exitCode === 127) return;
if (result.signal) {
  process.kill(process.pid, result.signal);
  return;
}
const lines = result.stdout.trim().split('\n');
const started = lines.includes('quorum-oracle: subject evaluation started');
let receipt;
try { receipt = JSON.parse(lines.at(-1)); } catch { /* No completed assertions. */ }
if (!started) {
  process.stderr.write(`checker failed before evaluating subject: ${result.stderr}\n`);
  process.exitCode = 127;
} else if (result.status === 0 && receipt?.completed === true && receipt.passed === true) {
  process.stdout.write('conversation oracle: pass\n');
  process.exitCode = 0;
} else {
  process.stdout.write(`conversation oracle: fail (${receipt?.detail ?? 'subject exited before assertions completed'})\n`);
  process.exitCode = 1;
}
