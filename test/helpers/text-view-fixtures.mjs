/** Deterministic presentation fixtures, not real Curator project metrics. */
const item=(id,title,content,layer='local')=>({id,title,content,layer,category:'state',scope:'global',status:'active',priority:'normal',revision:'a'.repeat(64)});
export function textViewFixtures(){
 const project={root:'/fixture/Curator',name:'Curator',initialized:true,knowledgeCount:128,localKnowledgeCount:86,versionedKnowledgeCount:42,skillCount:1,activeSessionCount:0,memoryOverview:{available:true,sessions:3,areas:[]}};
 const context={query:'Fix CLI update flow',required:[item('required','CLI update boundary','Updates run in a terminal.')],relevant:[item('relevant','Version verification','Check the version after updating.')],skills:[{id:'cli_checks',title:'CLI regression checks',content:'Verify cancel, confirm and exact version results.'}],snapshot:{version:1,sessionId:'fixture-session'},selection:{omittedRequired:[]},policyReadiness:{state:'ready',blocking:false},warnings:[],attention:[],metrics:{contextTokens:4320,contextBudgetTokens:6000,projectKnowledgeTokens:12000,requiredGlobalTokens:100,selectedContextualTokens:3200,selectedSkillsTokens:1020,requiredGlobalExcludedItems:0}};
 const matches=[item('mem_runtime','Node 22 runtime','Run project tools with Node 22.','versioned'),item('mem_layers','Knowledge layers','Local stays in this checkout. Versioned can be shared via Git.','versioned'),item('mem_update','CLI update workflow','In a terminal: prodero update.')];
 const binding={reviewId:'review_fixture',reviewRevisionId:'revision_fixture',planHash:'a'.repeat(64),decisionRevision:0,answerLogHash:'b'.repeat(64)};
 const question={id:'question_fixture',version:1,title:'Queue migration',prompt:'Has the migration to queue v2 completed?',allowFreeText:true,choices:[{id:'yes',label:'Completed',meaning:'Queue v2 is deployed.'},{id:'no',label:'Not completed',meaning:'Queue v2 is not deployed.'}]};
 const workflow={id:'workflow_fixture',root:project.root,revision:1,state:'awaiting_clarification',jobs:[{id:'area_fixture',label:'Queue migration',selected:true,status:'semantic_work',curationReviewId:binding.reviewId}],summary:{},promotionCandidates:[],questionCounts:{deferred:0,savedAnswerEvents:0,unsupersededAnswerEvents:0},clarification:{review:{snapshot:{reviewId:binding.reviewId,planHash:binding.planHash,revision:{id:binding.reviewRevisionId}},state:{revision:0}},graphical:{questions:[{question,state:'unanswered',needsInput:true}],jobs:[],analysisPending:false,answerLogHash:binding.answerLogHash}}};
 const deferred={...workflow,state:'completed',clarification:undefined,jobs:[],questionCounts:{...workflow.questionCounts,deferred:1},deferredQuestions:[{...binding,action:'question_reopen',candidateId:'area_fixture',title:question.title,prompt:question.prompt,expired:false,affectedQuestions:[{id:question.id,version:1,title:question.title}],questionId:question.id,questionVersion:1}]};
 return {
  home:{action:'open',project,bootstrap:{loaded:true,instructions:[],warnings:[],metrics:{estimatedTokens:480},limits:{budgetTokens:2000}},curation:{prominent:true,projection:{readyChangeGroups:4,deferredQuestions:2,analyzedSourceCount:8,needsInputNow:0,deferredChanges:0,unchanged:4}}},
  knowledge:{action:'knowledge',result:{root:project.root,matches,counts:{local:1,versioned:2,recommended:0},total:6,options:{offset:0,limit:3,query:''},nextOffset:3}},
  detail:{action:'knowledge',result:{root:project.root,detail:matches[0],matches:[],counts:{local:1,versioned:2,recommended:0},total:6,options:{offset:0,limit:3,query:''}}},
  ready:{action:'prepare',result:{project,context,session:{id:'fixture-session'},automaticSync:{sessionsProcessed:0}}},
  blocked:{action:'prepare',result:{project,context:{...context,policyReadiness:{state:'required-incomplete',blocking:true},metrics:{...context.metrics,requiredGlobalExcludedItems:1}}}},
  update:{action:'update-instructions',message:'Run prodero update in a terminal after closing hosts.'},
  question:{action:'memory-sync',result:workflow},
  deferred:{action:'memory-sync',result:deferred},
  retry:{action:'memory-sync',result:{...workflow,state:'completed',clarification:undefined,jobs:[{...workflow.jobs[0],status:'failed',error:'Analysis input expired. Inspect before retrying.'}],summary:{areasFailed:1}}},
  recovery:{action:'memory-sync',result:{...workflow,state:'applying',clarification:undefined}},
 };
}
