// Read only. Surface labels must come from the human experiment, never inferred.
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/compare-presentation-trace.mjs /absolute/trace.jsonl'); process.exit(1); }
const rows = fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.trace === 'prodero-presentation-v1');
const previous = new Map();
const fields = ['clientInfo','capabilities','meta','uiExtensionPresent','declaredMimeTypes','supportsMcpAppHtml','transportSession'];
for (const row of rows) {
  console.log(`${row.time} pid=${row.pid} connection=${row.connection} #${row.sequence} ${row.event}${row.call ? ` call=${row.call}` : ''}`);
  if (row.truncated) console.log('  INCOMPLETE: record was truncated; do not infer equality.');
  if (row.event === 'initialize.response') console.log(`  negotiated MCP: ${JSON.stringify(row.negotiatedProtocolVersion)}`);
  if (row.event.startsWith('metadata.')) console.log('  '+JSON.stringify(row));
  if (row.event === 'discovery.request') console.log('  method: '+row.method);
  if (!['open.request','control.request'].includes(row.event)) continue;
  const last = previous.get(row.connection + row.event);
  if (last) {
    if (last.pid !== row.pid || last.connection !== row.connection) console.log('  CONNECTION CHANGED: compare public values; opaque fingerprints may not be comparable across processes.');
    console.log('  Differences from previous call of this tool on this connection:', fields.filter(field=>!isDeepStrictEqual(last[field],row[field])).join(', ') || 'none in recorded fields');
  }
  for (const field of fields) console.log(`  ${field}: ${JSON.stringify(row[field])}`);
  previous.set(row.connection + row.event, row);
}
console.log('\nResource reads are NOT render acknowledgements. No mobile/desktop labels are inferred. An absent record or equal sanitized data does not prove identical presentation.');
