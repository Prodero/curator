import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { AGENTS_BLOCK, AGENT_INSTRUCTIONS_PATH } from '../../dist/core/templates.js';
export async function readAgentInstructions(root) {
 const agents=await fs.readFile(path.join(root,'AGENTS.md'),'utf8');
 assert.ok(agents.includes(AGENTS_BLOCK),'expected a three-line Prodero MCP reference');
 return fs.readFile(AGENT_INSTRUCTIONS_PATH,'utf8');
}
