import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { PRODERO_VERSION, PRODERO_SCHEMA_VERSION, PRODERO_KNOWLEDGE_SCHEMA_VERSION } from '../dist/core/constants.js';

test('release metadata, lock root, compiled runtime and App handshake share one package version',async()=>{
 const manifest=JSON.parse(await fs.readFile('package.json','utf8'));
 const lock=JSON.parse(await fs.readFile('package-lock.json','utf8'));
 const release=JSON.parse(await fs.readFile('prodero.release.json','utf8'));
 assert.match(manifest.version,/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
 assert.equal(lock.version,manifest.version);assert.equal(lock.packages[''].version,manifest.version);
 assert.equal(PRODERO_VERSION,manifest.version);
 assert.equal(PRODERO_SCHEMA_VERSION,release.schemaVersion);assert.equal(PRODERO_KNOWLEDGE_SCHEMA_VERSION,release.knowledgeSchemaVersion);
 const html=await fs.readFile('dist-ui/index.html','utf8');
 const escaped=manifest.version.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 assert.match(html,new RegExp('name:\\s*"Prodero Project Intelligence",\\s*version:\\s*"'+escaped+'"'));
 assert.ok(!html.includes('__PRODERO_VERSION__'),'App build must replace the version placeholder');
});

test('MCP initialize advertises the current package version without changing a project',async t=>{
 const server=createServer(),client=new Client({name:'release-version-check',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 assert.equal(client.getServerVersion().version,PRODERO_VERSION);
});
