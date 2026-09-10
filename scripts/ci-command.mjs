import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

// Preserve command status and logs; also expose a short result in the CI job summary.
const result = spawnSync(process.argv[2], process.argv.slice(3), { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const output = (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? '');
process.stdout.write(output);
const code = result.status ?? 1;
const summary = code === 0 ? 'Passed' : output.split('\n')
  .filter(line => /error TS|npm error|Error:|AssertionError|\s+at /.test(line)).slice(0, 5).join(' | ')
  .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1800) || 'Failed; see command log';
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `result=${summary}\n`);
process.exitCode = code;
