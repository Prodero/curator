import { PRODERO_VERSION } from '../../dist/core/constants.js';

// Fake available releases must stay newer than the runtime under test. Explicit
// historical upgrade fixtures keep their own independent version pairs.
export function nextPatchVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`Invalid fixture runtime version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}
export { PRODERO_VERSION };
export const NEXT_RUNTIME_VERSION = nextPatchVersion(PRODERO_VERSION);
