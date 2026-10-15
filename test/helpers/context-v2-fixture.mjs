// Invented toy-project fixtures; no real project incidents or operational records.
// Synthetic toy-grid allocation corpus. Fixed token costs are test inputs, not real-project measurements.
import fs from 'node:fs/promises';
import {initializeProject} from '../../dist/core/project.js';
import {writeKnowledge} from '../../dist/core/memory.js';
import {withApplicability} from '../../dist/core/applicability.js';
import {createProjectSkill} from '../../dist/core/skills.js';
import {estimateTokens,knowledgeText} from '../../dist/core/telemetry.js';
export async function emptyProject(t) {
 const root=await fs.mkdtemp('/tmp/prodero-allocation-');
 t?.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(root+'/.git');await initializeProject(root);return root;
}
export function record(id,app,policy='required',cost,content='Preserve the established safety boundary.') {
 const title=id.replaceAll('_',' ');
 let body=content;
 if(cost){const remaining=cost*4-Buffer.byteLength(title+'\n'+body);if(remaining<0)throw Error('fixture too small');body+=' '.repeat(remaining);}
 const item=withApplicability({version:3,id,scope:'global',scopeRef:null,category:policy==='required'?'instruction':'lesson',contextPolicy:policy,authority:policy==='required'?'legacy_inherited':'inferred',priority:'normal',status:'active',title,content:body,createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[],relations:[]},app);
 // Markdown trims trailing spaces. Use deterministic non-word padding instead.
 if(cost)item.content=body.replace(/ +$/,m=>'.'.repeat(m.length));
 if(cost&&estimateTokens(knowledgeText(item))!==cost)throw Error('cost mismatch');
 return item;
}
export const tasks=['Update README documentation','Fix ZED color picker','Update ToyGrid unit tests','Investigate toy trace history','Fix tile-layout rotation'];
export const requiredTotals=[233,1632,2357,691,431];
export async function phase3cFixture(t){
 const root=await emptyProject(t);
 for(const [id,cost]of [['Puzzle_notation',110],['Unique_tile_labels',123]])await writeKnowledge(root,record(id,{kind:'project'},'required',cost));
 for(const [subsystem,count,total]of [['ZED',7,1399],['ToyGrid',12,2124],['trace',3,458],['tile-layout',1,198]]){
  const app={kind:'scoped',subsystems:[subsystem],...(subsystem==='ToyGrid'?{taskKinds:['testing']}:{})};
  for(let i=0;i<count;i++)await writeKnowledge(root,record(`${subsystem}_boundary_${i}`,app,'required',Math.floor(total/count)+(i<total%count?1:0)));
 }
 const topics=['fixture seeding cleanup rollback','sprite rendering canvas interception','palette adapter color ownership','exception counters assertion observation','transaction ordering commit atomicity','request payload sanitization encoding','response mapping pagination cursors','authentication credentials fake principals','clock timestamps deterministic scheduling','queue dispatch worker draining','filesystem temporary directory disposal','cache invalidation key isolation','event subscribers listener teardown','serializer nullability schema compatibility','retry backoff jitter sampling','logger redaction correlation tracing'];
 for(let i=0;i<27;i++)await writeKnowledge(root,record(`ToyGrid_tests_procedure_${i}`,{kind:'scoped',subsystems:['ToyGrid'],taskKinds:['testing']},'relevant',90,`ToyGrid tests: ${topics[i%topics.length]}.`));
 for(const [s,count]of [['ZED',4],['trace',5],['tile-layout',1]])for(let i=0;i<count;i++)await writeKnowledge(root,record(`${s}_support_${i}`,{kind:'scoped',subsystems:[s]},'relevant',65,`${s} supporting historical procedure ${i}.`));
 await createProjectSkill(root,{title:'ToyGrid tests verification',description:'ToyGrid isolated verification workflow',scope:'ToyGrid',triggers:['ToyGrid tests'],content:'Run isolated test cases. Inspect fixture cleanup and captured sprites before broad verification.'});
 return root;
}
