// Optional trusted plugin. Runtime dependencies are public context services only.
const crypto = require('node:crypto');
const S = require('./schema.cjs');
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const pluginVersion = '1.7.0';
const eligible = new Set(['project_instruction', 'durable_project_knowledge', 'skill_candidate']);
const areas = ['runtime/memory', 'core/docs', 'core/agents', 'core/templates', 'runtime/handoffs', 'runtime/epic-runs'];
const importItems = plan => plan.items.filter(i => i.include).map(i => ({ key: i.id, destination: i.classification === 'skill_candidate' ? 'skill' : i.classification === 'project_instruction' ? 'project_instruction' : 'knowledge', title: i.title, content: i.content, scope: i.scope, scopeRef: i.scopeRef, category: i.category, ...(i.applicability?{applicability:i.applicability}:{}), evidence: [...i.source, ...i.repositoryEvidence], persistEvidence: true, reason: i.reason, skill: i.skill, activateSkill: i.activateSkill }));
const phases = ['audit', 'classify', 'migrate', 'verify'];
const analysisInstructions = pack => [pack.classify, pack.migrate, pack.verify].join('\n\n');
const sourcePath = p => p.startsWith('.ai-studio/');
const tokenCount = value => Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)) / 4);
const localMode = 'deterministic-memory-v1';
const modelMode = 'semantic-v1';
const planCache = new Map();
function rememberPlan(ctx, plan) {
    clean(ctx, plan);
    const key = `${hash(ctx.projectRoot)}:${plan.planId}`;
    planCache.delete(key);
    planCache.set(key, structuredClone(plan));
    while (planCache.size > 24)
        planCache.delete(planCache.keys().next().value);
    return plan;
}
function resolvePlan(ctx, raw, planId, action) {
    if (raw)
        return clean(ctx, raw);
    if (typeof planId !== 'string' || !/^[a-f0-9]{64}$/.test(planId))
        throw new Error(`${action} requires a valid planId. Run Audit again.`);
    const plan = planCache.get(`${hash(ctx.projectRoot)}:${planId}`);
    if (!plan)
        throw new Error(`${action} plan expired after the MCP restart. Run Audit again.`);
    return clean(ctx, structuredClone(plan));
}
const historyPath = p => /\/(?:handoffs?|epic-runs?|sessions?|logs?|transcripts?)(?:\/|$)/i.test(p) || /(?:handoff|epic-run|session|transcript|\.log$)/i.test(p);
const memoryPath = p => p.startsWith('.ai-studio/runtime/memory/') && /\.(?:md|txt)$/i.test(p) && !historyPath(p) && !/(?:^|\/)index\.md$/i.test(p);
const noModelCost = cost => ({ ...cost, estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedTotalTokens: 0, basis: 'measured-payloads' });
const sanitizePortableProse = value => String(value ?? '')
    .replace(/\b(?:TASK|EPIC)[-_ ]?\d+(?:\.\d+)?\b/gi, 'planned work')
    .replace(/\b(?:TASK|EPIC)(?:S)?-(?=[A-Za-z])/g, '')
    .replace(/planned work\s+(?:through|to|and|\/)\s+planned work/gi, 'planned work')
    .replace(/`?\.ai-studio(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?`?/gi, 'the legacy AI Studio workspace')
    .replace(/[ \t]+([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
const analysisInput = input => ({ sources: input.sources, repository: input.repository, existing: input.existing, existingOmitted: input.existingOmitted, excluded: input.excluded, uninspected: input.uninspected });
const nonEnglishProse = value => {
    const prose = String(value ?? '').replace(/```[\s\S]*?```|`[^`]*`/g, '');
    return [...prose].some(character => /\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character));
};
// Use Core's F03/F05 policy for whole packets, never a plugin-local detector.
function clean(ctx, value) { ctx.screening.assertSafe(value); return value; }
function screened(run) { return async (ctx, input) => {
    clean(ctx, input);
    try { return clean(ctx, await run(ctx, input)); }
    catch (error) { clean(ctx, String(error?.message ?? error)); throw error; }
}; }
function compare(a, b) { return hash(a) === hash(b); }
function seal(plan) { const { planId, ...body } = plan; return { ...body, planId: hash(body) }; }
function summary(items) { return {required:0,relevant:items.filter(i=>i.include&&i.classification!=="skill_candidate").length,scoped:items.filter(i=>i.include&&i.applicability?.kind==="scoped").length,unresolved:items.filter(i=>i.include&&i.applicability?.kind==="unresolved").length,categories:Object.fromEntries([...new Set(items.map(i=>i.category))].map(c=>[c,items.filter(i=>i.include&&i.category===c).length])),...Object.fromEntries(S.item.shape.classification.options.map(c => [c, items.filter(i => i.classification === c).length]))}; }
async function instructions(ctx) { const pack = {}; for (const phase of phases)
    pack[phase] = await ctx.assets.read(`instructions/${phase}.md`); return pack; }
async function detect(ctx) {
    const scan = await ctx.files.scan('.ai-studio', 2000);
    return { stage: 'detect', detected: scan.exists, applicable: scan.exists && scan.files.length > 0, files: scan.files.length, bytes: scan.files.reduce((s, f) => s + f.bytes, 0), truncated: scan.truncated, areas: areas.map(area => ({ path: `.ai-studio/${area}`, files: scan.files.filter(f => f.path.startsWith(`.ai-studio/${area}/`)).length })), samplingAvailable: Boolean(ctx.llm) };
}
async function gather(ctx, options = {}) {
    // Fail bounded integrity preflight before evidence/model preparation.
    const sourceSnapshot = await ctx.files.digest('.ai-studio');
    const repositorySnapshot = await ctx.files.digest('.', { exclude: ['.ai-studio'] });
    const detection = await detect(ctx);
    if (!detection.detected)
        throw new Error('No .ai-studio source detected');
    const scans = await Promise.all(['.ai-studio', ...areas.map(area => `.ai-studio/${area}`)].map(area => ctx.files.scan(area, 2000)));
    const inventoryFiles = [...new Map(scans.flatMap(scan => scan.files).map(file => [file.path, file])).values()];
    const candidates = inventoryFiles.filter(f => options.memoryOnly ? memoryPath(f.path) : /\.(md|txt|json|ya?ml)$/i.test(f.path));
    const selected = options.sourcePaths ?? candidates.sort((a, b) => {
        const rank = p => { const n = areas.findIndex(area => p.startsWith(`.ai-studio/${area}/`)); return n < 0 ? 99 : n; };
        return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
    }).slice(0, 24).map(f => f.path);
    const repositoryPaths = options.repositoryPaths ?? ['README.md', 'AGENTS.md', 'package.json'];
    if (!Array.isArray(selected) || selected.length > 36 || !Array.isArray(repositoryPaths) || repositoryPaths.length > 16)
        throw new Error('Audit selection exceeds file budget');
    const sources = [], repository = [], excluded = [];
    let sourceBytes = 0, repositoryBytes = 0;
    for (const [paths, target, isSource] of [[selected, sources, true], [repositoryPaths, repository, false]])
        for (const p of [...new Set(paths)]) {
            if (typeof p !== 'string' || (isSource ? !sourcePath(p) : sourcePath(p) || p.startsWith('.prodero/')))
                throw new Error('Invalid audit evidence area');
            try {
                const file = await ctx.files.read(p);
                const fileBytes = Buffer.byteLength(file.content), used = isSource ? sourceBytes : repositoryBytes, budget = isSource ? 80000 : 24000;
                if (used + fileBytes > budget) {
                    excluded.push({ path: p, reason: 'Audit text budget exceeded' });
                    continue;
                }
                if (isSource) sourceBytes += fileBytes; else repositoryBytes += fileBytes;
                target.push(file);
            }
            catch {
                excluded.push({ path: p, reason: 'Unavailable, oversized, binary or sensitive source; not sent to model' });
            }
        }
    const state = await ctx.state.read();
    const pack = await instructions(ctx);
    // Canonical text is bounded and screened before model transport. Hashes cover the bounded canonical integrity scope.
    const existing = { knowledge: [], skills: [] };
    let used = 0;
    for (const [items, target, limit] of [[state.knowledge, existing.knowledge, 24], [state.skills, existing.skills, 12]])
        for (const item of items) {
            const size = Buffer.byteLength(JSON.stringify(item));
            if (target.length < limit && used + size <= 32000 && !ctx.screening.hasSecret(JSON.stringify(item))) {
                target.push(item);
                used += size;
            }
        }
    const input = { importedKeys:state.importedKeys??[], importedSources:state.importedSources??[], inventory: inventoryFiles.map(f => ({ path: f.path, bytes: f.bytes })).slice(0, 500), inventoryTruncated: scans.some(scan => scan.truncated) || sourceSnapshot.files > inventoryFiles.length, sources, repository, existing, existingOmitted: state.knowledge.length + state.skills.length - existing.knowledge.length - existing.skills.length, excluded, uninspected: Math.max(0, sourceSnapshot.files - sources.length) };
    const analyzedBytes = [...sources, ...repository].reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
    const analyzedFiles = sources.length + repository.length;
    const projectedOutput = Math.min(24000, 1500 + analyzedFiles * 700);
    const schemas = tokenCount(S.json(S.audit)) + tokenCount(S.json(S.analysisTail));
    const estimatedInputTokens = tokenCount(pack.audit) + tokenCount(analysisInstructions(pack)) + tokenCount(input) + tokenCount(analysisInput(input)) + schemas + Math.round(projectedOutput * 1.5);
    const costEstimate = { method: 'estimated-utf8-bytes-div-4-v1', sourceFiles: sourceSnapshot.files, sourceBytes: sourceSnapshot.bytes, analyzedFiles, analyzedBytes, estimatedInputTokens, estimatedOutputTokens: projectedOutput, estimatedTotalTokens: estimatedInputTokens + projectedOutput, basis: 'preflight' };
    return clean(ctx, { version: 1, detection: { ...detection, files: sourceSnapshot.files, bytes: sourceSnapshot.bytes, truncated: false }, sourcePaths: sources.map(f => f.path), repositoryPaths: repository.map(f => f.path), instructionHash: hash(pack), projectBinding: hash(ctx.projectRoot), stateFingerprint: state.fingerprint, sourceSnapshot, repositorySnapshot, costEstimate,
        input, instructions: pack });
}
async function model(ctx, phase, input, pack, meter) {
    clean(ctx, input);
    const schema = S.json(S[phase]);
    if (meter)
        meter.input += tokenCount(pack[phase]) + tokenCount(input) + tokenCount(schema);
    const result = S[phase].parse(clean(ctx, await ctx.llm.json(pack[phase], input, schema)));
    if (meter)
        meter.output += tokenCount(result);
    return result;
}
async function analyze(ctx, input, pack, meter) {
    clean(ctx, input);
    const instructions = analysisInstructions(pack), schema = S.json(S.analysisTail);
    if (meter)
        meter.input += tokenCount(instructions) + tokenCount(input) + tokenCount(schema);
    const result = S.analysisTail.parse(clean(ctx, await ctx.llm.json(instructions, input, schema)));
    if (meter)
        meter.output += tokenCount(result);
    return result;
}
function measuredCost(packet, meter) { return { ...packet.costEstimate, estimatedInputTokens: meter.input, estimatedOutputTokens: meter.output, estimatedTotalTokens: meter.input + meter.output, basis: 'measured-payloads' }; }
async function estimate(ctx, input = {}) {
    const packet = await gather(ctx, { ...input, memoryOnly: true, repositoryPaths: [] });
    return { stage: 'estimate', detected: true, applicable: true, extractionMode: localMode, costEstimate: noModelCost(packet.costEstimate), coverage: { uninspected: packet.input.uninspected, excluded: packet.input.excluded.length, existingOmitted: packet.input.existingOmitted }, notice: 'Ready for local structured-memory extraction. No model call is required and no files were changed.' };
}
function validateEvidence(ref, packet, isSource) {
    const file = (isSource ? packet.input.sources : packet.input.repository).find(f => f.path === ref.path);
    if (!file || file.sha256 !== ref.sha256 || ref.startLine > ref.endLine || ref.endLine > file.content.split('\n').length)
        throw new Error('Unsupported evidence reference in migration analysis');
}
function validateItems(items, packet, sourceOnly = false) {
    const ids = new Set();
    for (const item of items) {
        const prose = [item.title, item.content, item.reason, ...(item.warnings ?? []), item.skill?.title, item.skill?.description, item.skill?.scope, ...(item.skill?.triggers ?? []), item.skill?.content];
        if (prose.some(nonEnglishProse))
            throw new Error('Migration knowledge must be written in English; preserve exact non-English identifiers or code literals in backticks');
        if (ids.has(item.id))
            throw new Error('Duplicate migration item ID');
        ids.add(item.id);
        item.source.forEach(r => validateEvidence(r, packet, true));
        item.repositoryEvidence.forEach(r => validateEvidence(r, packet, false));
        if ((item.scope === 'global') !== (item.scopeRef === null))
            throw new Error('Invalid knowledge scope');
        if (item.activateSkill)
            throw new Error('Analysis cannot activate skills; human review is required');
        if (item.classification === 'skill_candidate') {
            if (!item.skill || item.skill.title !== item.title || item.skill.content !== item.content)
                throw new Error('Skill needs a matching structured procedure');
        }
        else if (item.skill !== null)
            throw new Error('Project facts must not be stored as skills');
        if (item.classification === 'project_instruction' && item.category !== 'instruction')
            throw new Error('Project instruction has incorrect category');
        if (item.include && (!eligible.has(item.classification) || (!sourceOnly && !item.repositoryEvidence.length) || !item.content.trim()))
            throw new Error('Unsupported, stale, duplicate or uncertain item cannot be included');
    }
}
function validateVerification(verification, items) {
    if (!compare([...verification.reviewedItemIds].sort(), items.map(i => i.id).sort()))
        throw new Error('Verification must cover every plan item exactly once');
    for (const issue of verification.issues)
        if (issue.itemId !== null && !items.some(i => i.id === issue.itemId))
            throw new Error('Verification cites an unknown item');
}
function makePlan(packet, raw, extractionMode = modelMode, ctx) {
    const analysis = S.analysis.parse(clean(ctx, raw));
    if (!compare(analysis.classify.items.map(i => i.id).sort(), analysis.migrate.items.map(i => i.id).sort()))
        throw new Error('Migration must account for every classified item');
    for (const item of analysis.migrate.items) {
        const classification = analysis.classify.items.find(i => i.id === item.id);
        for (const key of ['classification', 'source', 'repositoryEvidence', 'reason'])
            if (!compare(item[key], classification[key]))
                throw new Error('Migration changed classification or provenance; classify again');
    }
    const items = analysis.migrate.items;
    for(const item of items) if(item.classification!=="skill_candidate" && !item.applicability && ctx) item.applicability=ctx.state.analyze(item.title,item.content)[0]?.applicability??{kind:"unresolved"};
    validateItems(items, packet, extractionMode === localMode);
    validateVerification(analysis.verify, items);
    for (const issue of analysis.verify.issues)
        if (issue.severity === 'conflict')
            for (const item of items)
                if (issue.itemId === null || issue.itemId === item.id) {
                    item.include = false;
                    item.warnings.push(issue.message);
                }
    return S.plan.parse(seal({ version: 1, sourceSystem: 'ai-studio', pluginId: 'migrate_ai_studio', pluginVersion, extractionMode, instructionHash: packet.instructionHash, projectBinding: packet.projectBinding, stateFingerprint: packet.stateFingerprint, sourceSnapshot: packet.sourceSnapshot, repositorySnapshot: packet.repositorySnapshot, costEstimate: packet.costEstimate, items:items.map(i=>S.item.parse(i)), coverage: { uninspected: packet.input.uninspected, excluded: packet.input.excluded, existingOmitted: packet.input.existingOmitted }, audit: analysis.audit, verification: analysis.verify, reviewed: false }));
}
function durableSections(packet, ctx) {
    const fieldsToKeep = new Set(['principle', 'invariant', 'reason', 'state', 'lesson', 'decision', 'impact', 'constraint', 'correction', 'guard pattern', 'workflow note', 'test-quality note']);
    const existing = new Set(packet.input.existing.knowledge.map(item => String(item.content ?? '').trim().replace(/\s+/g, ' ').toLowerCase()));
    const seen = new Set(), items = [];
    for (const file of packet.input.sources.filter(file => memoryPath(file.path))) {
        const lines = file.content.split('\n');
        const headings = lines.flatMap((line, index) => /^#{2,3}\s+(.+?)\s*$/.test(line) ? [{ index, title: line.replace(/^#{2,3}\s+/, '').trim() }] : []);
        const sections = headings.length ? headings.map((heading, index) => ({ ...heading, end: (headings[index + 1]?.index ?? lines.length) - 1 })) : [{ index: 0, end: lines.length - 1, title: file.path.split('/').pop().replace(/\.[^.]+$/, '') }];
        for (const section of sections) {
            const values = new Map(); let field = null;
            for (let index = section.index + 1; index <= section.end; index++) {
                const match = lines[index].match(/^([A-Za-z][A-Za-z -]{1,40}):\s*$/);
                if (match) { field = match[1].trim().toLowerCase(); if (!values.has(field)) values.set(field, []); continue; }
                if (field && values.has(field)) values.get(field).push(lines[index]);
            }
            const decision = (values.get('decision') ?? values.get('constraint') ?? values.get('state') ?? values.get('lesson') ?? values.get('principle') ?? values.get('invariant') ?? []).join('\n').trim();
            if (!decision) continue;
            const blocks = [...values].filter(([name, body]) => fieldsToKeep.has(name) && body.join('').trim()).map(([name, body]) => `${name.replace(/(^| )[a-z]/g, value => value.toUpperCase())}:\n${sanitizePortableProse(body.join('\n'))}`);
            const content = sanitizePortableProse(blocks.join('\n\n')).trim();
            if(content.length>6000)throw new Error('Structured source entry exceeds the safe import size. Narrow or explicitly decompose this source before importing.');
            const normalized = content.replace(/\s+/g, ' ').toLowerCase();
            if (!content || seen.has(normalized)) continue;
            seen.add(normalized);
            const legacyContent = sanitizePortableProse(blocks.filter(b=>! /^(?:Reason|State|Lesson|Principle|Invariant):/.test(b)).join('\n\n')).slice(0,6000).trim().replace(/\s+/g,' ').toLowerCase();
            const legacyId = `memory-${hash(`${file.path}:${section.index+1}:${legacyContent}`).slice(0,16)}`;
            const baseId = `memory-${hash(`${file.path}:${section.index + 1}:${normalized}`).slice(0,16)}`;
            const duplicate = existing.has(normalized) || (packet.input.importedKeys??[]).some(key=>key===baseId||key.startsWith(baseId+'-')||key===legacyId||key.startsWith(legacyId+'-'));
            const priorSource = (packet.input.importedSources??[]).find(e=>e.path===file.path&&e.startLine===section.index+1);
            const sourceUpdate = !duplicate && !!priorSource;
            const instruction = false; // Historical grammar is not current policy authority.
            const firstSentence = sanitizePortableProse(decision.replace(/[*#]/g, '').replace(/\s+/g, ' ')).split(/(?<=[.!?])\s/)[0];
            const proposedTitle = (firstSentence.length > 180 ? `${firstSentence.slice(0, 177).trimEnd()}...` : firstSentence) || section.title;
            const unsupportedLanguage = nonEnglishProse(content) || nonEnglishProse(proposedTitle);
            const classification = duplicate ? 'duplicate' : sourceUpdate || unsupportedLanguage ? 'uncertain' : instruction ? 'project_instruction' : 'durable_project_knowledge';
            const id = `memory-${hash(`${file.path}:${section.index + 1}:${normalized}`).slice(0, 16)}`;
            const parts = duplicate || unsupportedLanguage ? [{title:proposedTitle,content,category:'decision',applicability:{kind:'unresolved'}}] : ctx.state.analyze(proposedTitle,content);
            if(items.length+parts.length>60)return items;
            for (const [partIndex, part] of parts.entries()) {
            items.push({ id: `${id}-${partIndex}`, classification, source: [{ path: file.path, sha256: file.sha256, startLine: section.index + 1, endLine: section.end + 1 }], repositoryEvidence: [], reason: sourceUpdate ? 'This source section was previously imported and has changed. Review the existing canonical record through curation; normal import does not overwrite it.' : duplicate ? 'Equivalent durable content already exists in Prodero.' : unsupportedLanguage ? 'Non-English source prose requires manual translation before import.' : 'Extracted from a structured durable AI Studio project-memory entry for human review.', applicability:part.applicability, title: unsupportedLanguage ? 'Excluded non-English memory entry' : part.title, content: unsupportedLanguage ? '' : part.content, scope: 'global', scopeRef: null, category: part.category, skill: null, include: !sourceUpdate && !duplicate && !unsupportedLanguage, activateSkill: false, warnings: unsupportedLanguage ? ['Excluded because durable Prodero prose must be English.'] : [] });
            }
            if (items.length === 60) return items;
        }
    }
    return items;
}
function localPlan(packet, ctx) {
    packet.costEstimate = noModelCost(packet.costEstimate);
    const items = durableSections(packet, ctx);
    const audit = { version: 1, findings: [`Extracted ${items.length} structured durable-memory entries locally.`], inspectPaths: [], warnings: items.length === 60 ? ['Only the first 60 durable entries are shown; narrow sourcePaths to review another segment.'] : [] };
    const classify = { version: 1, items: items.map(({ id, classification, source, repositoryEvidence, reason }) => ({ id, classification, source, repositoryEvidence, reason })) };
    const migrate = { version: 1, items };
    const verify = { version: 1, reviewedItemIds: items.map(item => item.id), issues: [] };
    return makePlan(packet, { audit, classify, migrate, verify }, localMode, ctx);
}
async function validatePlan(ctx, raw, current = true) {
    if (!raw || raw.pluginId !== 'migrate_ai_studio' || raw.pluginVersion !== pluginVersion)
        throw new Error(`This Review belongs to an older migration plan. Run Audit again with plugin ${pluginVersion}.`);
    const plan = S.plan.parse(clean(ctx, raw));
    if (plan.planId !== seal(plan).planId || plan.projectBinding !== hash(ctx.projectRoot))
        throw new Error('Plan digest or project binding mismatch');
    if (plan.instructionHash !== hash(await instructions(ctx)))
        throw new Error('Migration instructions changed; audit again');
    validateVerification(plan.verification, plan.items);
    if (!current)
        return plan;
    if (current && (!compare(plan.sourceSnapshot, await ctx.files.digest('.ai-studio')) || !compare(plan.repositorySnapshot, await ctx.files.digest('.', { exclude: ['.ai-studio'] }))))
        throw new Error('Source or repository changed since audit');
    const packet = { input: { sources: [], repository: [] } };
    for (const [refs, target] of [[plan.items.flatMap(i => i.source), packet.input.sources], [plan.items.flatMap(i => i.repositoryEvidence), packet.input.repository]])
        for (const p of [...new Set(refs.map(r => r.path))])
            target.push(await ctx.files.read(p));
    for (const item of plan.items) {
        if (item.source.some(e => !sourcePath(e.path)) || item.repositoryEvidence.some(e => sourcePath(e.path) || e.path.startsWith('.prodero/')))
            throw new Error('Invalid plan evidence area');
        if (item.activateSkill && (!plan.reviewed || item.classification !== 'skill_candidate' || !item.include))
            throw new Error('Skill activation requires reviewed inclusion');
    }
    validateItems(plan.items.map(i => ({ ...i, activateSkill: false })), packet, plan.extractionMode === localMode);
    for (const issue of plan.verification.issues)
        if (issue.severity === 'conflict' && plan.items.some(i => i.include && (issue.itemId === null || issue.itemId === i.id)))
            throw new Error('Unresolved verification conflict');
    return plan;
}
async function audit(ctx, input = {}) {
    let packet = await gather(ctx, { ...input, memoryOnly: input.semantic !== true, ...(input.semantic === true ? {} : { repositoryPaths: [] }) });
    if (input.semantic !== true) {
        const plan = localPlan(packet, ctx);
        await ctx.state.validate(importItems(plan));
        rememberPlan(ctx, plan);
        return { stage: 'review', extractionMode: localMode, plan, summary: summary(plan.items), coverage: plan.coverage, notice: 'Durable project-memory entries were extracted locally. No model was called and no files were changed.' };
    }
    if (!ctx.llm)
        return { stage: 'audit', status: 'needs_analysis', costEstimate: packet.costEstimate, auditPackage: packet, auditOutputSchema: S.json(S.audit), analysisOutputSchema: S.json(S.analysisTail), notice: 'Server sampling unavailable. Continue model analysis inside this App; no files were changed.' };
    const meter = { input: 0, output: 0 };
    const first = await model(ctx, 'audit', packet.input, packet.instructions, meter);
    if (first.inspectPaths.length) {
        packet = await gather(ctx, { sourcePaths: [...new Set([...packet.sourcePaths, ...packet.input.excluded.filter(f => sourcePath(f.path)).map(f => f.path), ...first.inspectPaths.filter(sourcePath)])], repositoryPaths: [...new Set([...packet.repositoryPaths, ...packet.input.excluded.filter(f => !sourcePath(f.path)).map(f => f.path), ...first.inspectPaths.filter(p => !sourcePath(p))])] });
    }
    const remaining = await analyze(ctx, { ...analysisInput(packet.input), audit: first }, packet.instructions, meter);
    packet.costEstimate = measuredCost(packet, meter);
    const plan = makePlan(packet, { audit: first, ...remaining }, modelMode, ctx);
    await ctx.state.validate(importItems(plan));
    rememberPlan(ctx, plan);
    return { stage: 'review', plan, summary: summary(plan.items), coverage: { uninspected: packet.input.uninspected, excluded: packet.input.excluded, existingOmitted: packet.input.existingOmitted } };
}
async function planAction(ctx, { auditPackage, analysis } = {}) {
    if (!auditPackage)
        throw new Error('Run read-only audit first');
    const packet = await gather(ctx, { sourcePaths: auditPackage.sourcePaths, repositoryPaths: auditPackage.repositoryPaths });
    for (const key of ['instructionHash', 'projectBinding', 'stateFingerprint', 'sourceSnapshot', 'repositorySnapshot'])
        if (!compare(packet[key], auditPackage[key]))
            throw new Error('Audit evidence changed; run audit again');
    const plan = makePlan(packet, analysis, modelMode, ctx);
    await ctx.state.validate(importItems(plan));
    rememberPlan(ctx, plan);
    return { stage: 'review', plan, summary: summary(plan.items) };
}
async function review(ctx, { plan: suppliedPlan, planId, decisions } = {}) {
    const raw = resolvePlan(ctx, suppliedPlan, planId, 'Review');
    const plan = await validatePlan(ctx, raw);
    if (!Array.isArray(decisions) || decisions.length !== plan.items.length || new Set(decisions.map(d => d.id)).size !== plan.items.length)
        throw new Error('Review requires one inclusion decision for every item');
    for (const item of plan.items) {
        const decision = decisions.find(d => d.id === item.id);
        if (!decision || typeof decision.include !== 'boolean' || typeof decision.activateSkill !== 'boolean')
            throw new Error('Invalid review decision');
        item.include = decision.include;
        item.activateSkill = decision.activateSkill;
    }
    plan.reviewed = true;
    const reviewed = await validatePlan(ctx, seal(plan));
    await ctx.state.validate(importItems(reviewed));
    rememberPlan(ctx, reviewed);
    return { stage: 'review', plan: reviewed, summary: summary(reviewed.items), notice: 'Review complete. Import applies this exact plan; skill activation needs explicit human selection.' };
}
async function apply(ctx, { plan: suppliedPlan, planId, approvedPlanId } = {}) {
    const raw = resolvePlan(ctx, suppliedPlan, planId, 'Import');
    const plan = await validatePlan(ctx, raw);
    if (!plan.reviewed || approvedPlanId !== plan.planId)
        throw new Error('Apply requires the exact reviewed and approved plan');
    const items = importItems(plan);
    const receipt = await ctx.state.apply({ version: 1, planId: plan.planId, approvedPlanId, stateFingerprint: plan.stateFingerprint, items });
    return { stage: 'apply', plan, receipt, imported: receipt.created.length, duplicates: receipt.duplicates.length, skipped: plan.items.length - items.length, notice: 'Import applied. Run Verify to check the resulting state.' };
}
async function verify(ctx, { plan: suppliedPlan, planId, receipt, semantic = false } = {}) {
    const raw = resolvePlan(ctx, suppliedPlan, planId, 'Verify');
    const plan = await validatePlan(ctx, raw, false);
    if (receipt?.planId !== plan.planId || receipt?.plugin !== ctx.plugin.id)
        throw new Error('Receipt does not match plan');
    const mechanical = await ctx.state.verify(receipt);
    const issues = [...mechanical.issues];
    if (!compare(plan.sourceSnapshot, await ctx.files.digest('.ai-studio')))
        issues.push('AI Studio integrity-scope files changed');
    if (!compare(plan.repositorySnapshot, await ctx.files.digest('.', { exclude: ['.ai-studio'] })))
        issues.push('Unrelated repository integrity-scope files changed');
    // Selected evidence may intentionally be Git-ignored legacy input. It has its own exact hashes.
    for (const ref of new Map(plan.items.filter(i => i.include).flatMap(i => [...i.source, ...i.repositoryEvidence]).map(ref => [ref.path, ref])).values()) {
        try { if ((await ctx.files.read(ref.path)).sha256 !== ref.sha256) issues.push('Selected import evidence changed'); }
        catch { issues.push('Selected import evidence unavailable or excluded'); }
    }
    const expected = plan.items.filter(i => i.include).map(i => i.id).sort();
    if (!compare(expected, [...receipt.created, ...receipt.duplicates].map(i => i.key).sort()))
        issues.push('Applied items differ from included plan items');
    let semanticReport = null;
    if (semantic && ctx.llm) {
        const packet = await gather(ctx, { sourcePaths: [...new Set(plan.items.flatMap(i => i.source.map(r => r.path)))], repositoryPaths: [...new Set(plan.items.flatMap(i => i.repositoryEvidence.map(r => r.path)))] });
        semanticReport = await model(ctx, 'verify', { ...packet.input, proposal: { items: plan.items }, receipt, mechanical }, packet.instructions);
        validateVerification(semanticReport, plan.items);
        for (const issue of semanticReport.issues)
            if (issue.severity === 'conflict')
                issues.push(issue.message);
    }
    return { stage: 'verify', plan, receipt, valid: issues.length === 0, issues, semantic: semanticReport, semanticStatus: semanticReport ? 'reviewed' : 'not_requested_or_unavailable', imported: receipt.created.length, skillsCreated: receipt.created.filter(i => i.destination === 'skill').length, duplicates: receipt.duplicates.length, skipped: plan.items.length - expected.length, planId: plan.planId, checkpoint: receipt.checkpoint };
}
exports.actions = {
    detect: { title: 'Detect', description: 'Cheap read-only source detection', readOnly: true, run: screened(detect) },
    estimate: { title: 'Estimate', description: 'Estimate model tokens locally before starting the audit', readOnly: true, run: screened(estimate) },
    audit: { title: 'Audit', description: 'Read-only staged LLM audit, or instruction packet when sampling is unavailable', readOnly: true, run: screened(audit) },
    plan: { title: 'Create plan', description: 'Validate agent-supplied analysis against a prior audit package', readOnly: true, run: screened(planAction) },
    review: { title: 'Review', description: 'Review include/exclude decisions and explicit skill activation before import', readOnly: true, run: screened(review) },
    apply: { title: 'Import', description: 'Apply exact reviewed plan with approvedPlanId; never modify source files', readOnly: false, run: screened(apply) },
    verify: { title: 'Verify', description: 'Check imported state, exclusions, scoped source integrity and optional semantic verification', readOnly: true, run: screened(verify) },
};
