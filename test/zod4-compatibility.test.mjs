import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import Ajv from 'ajv';
import {jsonSchema} from '../dist/core/json-schema.js';
import {knowledgeQuerySchema} from '../dist/core/knowledge-management.js';
import {skillInputSchema} from '../dist/core/skills.js';
import {applicabilitySchema} from '../dist/core/applicability.js';
import {semanticLimitsSchema,semanticProposalSchema} from '../dist/core/curation-semantic-contract.js';
import {memorySyncActionSchema} from '../dist/core/memory-sync.js';
import {receiptSchema} from '../dist/hosts/manager.js';
import {distillSchema,INTELLIGENCE_LIMITS} from '../dist/core/intelligence.js';
import {createServer} from '../dist/server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const require=createRequire(import.meta.url);
const schemas={knowledgeQuerySchema,skillInputSchema,applicabilitySchema,semanticLimitsSchema,memorySyncActionSchema,receiptSchema};
const {vectors}=JSON.parse(await fs.readFile(new URL('./fixtures/zod3-contract-vectors.json',import.meta.url),'utf8'));

for(const vector of vectors)test(`Zod 3 serialized contract: ${vector.name}`,()=>{
 const result=schemas[vector.schema].safeParse(vector.input);
 assert.equal(result.success,vector.accepted);
 if(result.success)assert.deepEqual(result.data,vector.output);
});

function observedArray(length){let reads=0;const value=Array.from({length},()=>null);Object.defineProperty(value,0,{get(){reads++;return null;},enumerable:true});return{value,reads:()=>reads};}
test('oversized provider collections reject before validating even the first element',()=>{
 const a=observedArray(INTELLIGENCE_LIMITS.candidatesPerBatch+1),result=distillSchema.safeParse({candidates:a.value});
 assert.equal(result.success,false);assert.equal(a.reads(),0);
 assert.deepEqual(result.error.issues.map(i=>({path:i.path,code:i.code})),[{path:['candidates'],code:'too_big'}]);
});
test('oversized semantic sources reject before clause and protection validation',()=>{
 const a=observedArray(33),result=semanticProposalSchema.safeParse({version:1,bundleId:'bundle_fixture',sources:a.value,relations:[],outputs:[],issues:[],answerInterpretations:[],additionalEvidenceRequired:[],rationale:'Preserve source evidence.',limitations:[]});
 assert.equal(result.success,false);assert.equal(a.reads(),0);
 assert.deepEqual(result.error.issues.map(i=>({path:i.path,code:i.code})),[{path:['sources'],code:'too_big'}]);
});
test('provider and plugin JSON Schema remain complete draft-7 input contracts',()=>{
 const ajv=new Ajv({strict:false}),skill=jsonSchema(skillInputSchema),validate=ajv.compile(skill);
 assert.equal(skill.$schema,'http://json-schema.org/draft-07/schema#');
 assert.equal(skill.type,'object');assert.deepEqual(skill.required,['title','description','content']);
 assert.equal(validate({title:'Inspect fixture',description:'Check source.',content:'Keep provenance.'}),true);
 assert.equal(validate({title:'Inspect fixture',description:'Check source.'}),false);
 assert.equal(validate({title:'Inspect fixture',description:'Check source.',content:'Keep provenance.',triggers:Array(21).fill('x')}),false);
 const plugin=require('../plugins/migrate_ai_studio/schema.cjs');
 for(const name of ['audit','classify','migrate','verify','analysis','analysisTail','plan','item']){
  const shape=plugin.json(plugin[name]);assert.equal(shape.type,'object',name);assert.ok(Object.keys(shape.properties).length>0,name);ajv.compile(shape);
 }
 const validateAudit=ajv.compile(plugin.json(plugin.audit));
 assert.equal(validateAudit({version:1,findings:[],inspectPaths:[],warnings:[]}),true);
 assert.equal(validateAudit({version:1,findings:[],inspectPaths:[],warnings:[],approved:true}),false);
});
test('MCP tool discovery advertises compilable object schemas after Zod 4 migration',async t=>{
 const s=createServer(),c=new Client({name:'zod4-contract-regression',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await s.connect(b);await c.connect(a);t.after(async()=>{await c.close();await s.close();});
 const {tools}=await c.listTools(),ajv=new Ajv({strict:false,validateFormats:false});
 for(const tool of tools){assert.equal(tool.inputSchema.type,'object',tool.name);ajv.compile(tool.inputSchema);}
 const prepare=tools.find(x=>x.name==='prodero_prepare').inputSchema;
 assert.ok(prepare.properties.taskContext.properties.paths.items);assert.ok(prepare.properties.taskContext.properties.explicitTopics.items||prepare.properties.taskContext.properties.explicitTopics.$ref);
 const knowledge=ajv.compile(tools.find(x=>x.name==='prodero_knowledge').inputSchema);
 assert.equal(knowledge({query:'Cedar',offset:0,limit:12}),true);assert.equal(knowledge({limit:21}),false);
 const mutate=ajv.compile(tools.find(x=>x.name==='prodero_knowledge_mutate').inputSchema);
 assert.equal(mutate({id:'mem_fixture',revision:'a'.repeat(64),action:'edit',approved:true,title:'Fixture',content:'Keep provenance.'}),true);
 assert.equal(mutate({id:'mem_fixture',revision:'a'.repeat(64),action:'edit',approved:false,title:'Fixture',content:'Keep provenance.'}),false);
});
