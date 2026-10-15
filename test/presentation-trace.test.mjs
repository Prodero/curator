import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, PRODERO_RESOURCE_URI } from '../dist/server.js';

async function run(enabled, action, destination) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prodero-trace-test-'));
  await fs.mkdir(path.join(root, '.git'));
  const file = destination ?? path.join(root, 'trace.jsonl');
  const before = [process.env.PRODERO_DEBUG_PRESENTATION, process.env.PRODERO_DEBUG_PRESENTATION_FILE];
  process.env.PRODERO_DEBUG_PRESENTATION = enabled ? '1' : '0';
  process.env.PRODERO_DEBUG_PRESENTATION_FILE = file;
  const server = createServer({ projectRoot: root });
  const client = new Client({ name: 'codex', version: '1.2.3', title: 'PRIVATE_USER_TITLE' }, { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'], secret: 'PRIVATE_CAPABILITY' } } } });
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    await action(client, file);
  } finally {
    await client.close(); await server.close();
    for (const [i,key] of ['PRODERO_DEBUG_PRESENTATION','PRODERO_DEBUG_PRESENTATION_FILE'].entries()) {
      if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i];
    }
  }
  return {file, root};
}

test('presentation trace is absent by default/off', async () => {
  const {file} = await run(false, async client => {
    const result = await client.callTool({name:'prodero_open', arguments:{}});
    assert.equal(result.structuredContent.action, 'open');
  });
  await assert.rejects(fs.stat(file), {code:'ENOENT'});
});

test('passive trace preserves responses, correlates reads, and redacts private data', async () => {
  const {file} = await run(true, async (client,file) => {
    const tools = await client.listTools();
    assert.equal(tools.tools.some(t=>t.name.includes('trace')), false);
    const call = meta => client.callTool({name:'prodero_open', arguments:{scope:'PRIVATE_SCOPE'}, _meta:meta});
    const first = await call({'openai/userAgent':'PRIVATE_AGENT_DESKTOP', arbitrary:'PRIVATE_META'});
    const second = await call({'openai/userAgent':'PRIVATE_AGENT_MOBILE', arbitrary:'PRIVATE_META'});
    assert.deepEqual(first, second);
    assert.deepEqual(Object.keys(first).sort(), ['content','structuredContent']);
    const beforeRead = (await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(beforeRead.some(e=>e.event==='status-resource.read'), false);
    const resource = await client.readResource({uri:PRODERO_RESOURCE_URI});
    assert.match(resource.contents[0].text, /html/i);
  });
  const raw = await fs.readFile(file,'utf8');
  assert.doesNotMatch(raw, /PRIVATE_|<!doctype|bootstrap|projectRoot/i);
  const events = raw.trim().split('\n').map(JSON.parse);
  assert.equal(new Set(events.map(e=>e.connection)).size, 1);
  const init = events.find(e=>e.event==='initialize.response');
  assert.equal(init.negotiatedProtocolVersion, '2025-11-25');
  assert.equal(init.clientInfo.name, 'codex');
  assert.equal(init.clientInfo.version, '1.2.3');
  assert.equal(init.supportsMcpAppHtml, true);
  const opens = events.filter(e=>e.event==='open.request');
  assert.deepEqual(opens[0].capabilities, opens[1].capabilities);
  assert.notDeepEqual(opens[0].meta['openai/userAgent'], opens[1].meta['openai/userAgent']);
  assert.equal(events.filter(e=>e.event==='status-resource.read').length,1);
  assert.equal(events.some(e=>e.event==='connection.closed'),true);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('unwritable trace destination never breaks tool calls', async () => {
  await run(true, async client => {
    const result = await client.callTool({name:'prodero_open', arguments:{}});
    assert.equal(result.structuredContent.action, 'open');
  }, '/dev/null/not-a-file');
});
