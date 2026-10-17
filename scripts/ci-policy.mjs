import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Only these documentation-only changes may omit the installed-artifact checks.
// Unknown paths, runtime/instructions, tests, build scripts, manifests and workflows
// deliberately default to integration. Renames include both old and new paths.
export function needsIntegration(files) {
  return !files?.length || files.some(file => !(
    /^(?:README|CHANGELOG|CONTRIBUTING|SECURITY|ARCHITECTURE)\.md$/.test(file) ||
    file === 'LICENSE' ||
    /^docs\/(?:[^/]+\.md|images\/[^/]+\.png)$/.test(file)
  ));
}

export function gateMode(eventName, ref) {
  return eventName === 'workflow_dispatch' || ref.startsWith('refs/tags/') ? 'full' : 'fast';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let files;
  const base = process.env.CI_BASE_SHA;
  if (base && /^[a-f0-9]{40}$/.test(base) && !/^0+$/.test(base)) {
    try {
      files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    } catch {
      console.log('Base unavailable: require installed-artifact integration checks');
    }
  }
  const integration = needsIntegration(files);
  console.log(`Changed paths: ${JSON.stringify(files ?? 'unknown')}; integration: ${integration}`);
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `integration=${integration}\n`);
}
