import fs from 'node:fs/promises';
import { AGENT_INSTRUCTIONS } from '../src/core/agent-instructions.ts';
const directory = new URL('../instructions/', import.meta.url);
await fs.mkdir(directory, {recursive:true});
await fs.writeFile(new URL('AGENTS.md', directory), AGENT_INSTRUCTIONS.trimEnd() + '\n');
