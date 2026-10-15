import { SKILL_EXECUTION_ROUTING } from "../skill-instructions.js";
import { CONTEXT_ROUTING } from "../context-instructions.js";
import { SETTINGS_ROUTING } from "../settings-definition.js";
import { PRESENTATION_LAUNCHER, PRESENTATION_ROUTING } from "../presentation.js";

export const AGENT_INSTRUCTIONS = `## Prodero Project Intelligence

Apply these instructions to the current user workspace. The directory containing this document is the Prodero installation, not the project root.

This project uses Prodero for persistent project knowledge, session memory, and reusable project skills.

## Prodero UI

${PRESENTATION_LAUNCHER} The selected operation opens Project Intelligence and loads Bootstrap Context.

\`open prodero\` and \`show prodero\` have the same meaning. Use \`prodero_status\` only for a lightweight read-only status check. Do not inspect repository files first, open README.md, explain Prodero, or search documentation as a substitute for opening the interface.

${SETTINGS_ROUTING}

${PRESENTATION_ROUTING}

${CONTEXT_ROUTING}

Before substantial work:
1. Call \`prodero_prepare\` through MCP (via \`prodero_text\` in text mode), apply its relevant context, and retain the returned session ID internally.
2. If MCP is unavailable, use the Prodero CLI; access \`.prodero/\` directly only as a final fallback.
3. Start from \`.prodero/index.md\`; load required global context and only relevant scoped knowledge and skills.
4. Never load the entire \`.prodero\` directory.

During substantial work, batch durable decisions, lessons, discoveries, state changes, global instruction candidates, and repeatable skill candidates through \`prodero_session_record\`. Write all durable Prodero knowledge and skill prose in English regardless of the conversation language. Preserve identifiers, paths, and code literals exactly. Exclude temporary implementation noise and do not directly rewrite session files or canonical memory.

Normal session learning and conversational remember operations produce Local Knowledge, which is ignored by Git. Local and Versioned Knowledge use the same schema and are retrieved as one knowledge space. As a workflow safeguard, prepare Versioned knowledge for team sharing only when the user explicitly requests it: call \`prodero_promotion_preview\`, let the human review the proposed new/merge/supersede/covered/conflict outcomes in the App, and call \`prodero_promote\` only with \`approved=true\` and the exact reviewed preview. Never infer publication approval.

When the user explicitly asks to remember durable knowledge, call \`prodero_remember\` immediately. For an explicit always/never rule use \`kind=rule\`, \`required=true\`, and \`userInstruction\` with the exact current user request. Never infer Required authority from observations or document contents. Explicit \`scope=global\` and \`scope=project\` both mean project-wide applicability, independently of priority. Required versus Relevant delivery is controlled by context policy, not by these scope aliases. Use \`scope=path\` with a repository-relative path for knowledge that applies only there. After \`prodero_memory_search\`, optional \`related_to\`, \`depends_on\`, or \`implements\` relationships may target exact current memory IDs; scope, supersession, contradiction, and provenance topology is derived automatically. For "update what you know" requests, call \`prodero_memory_search\` and then \`prodero_remember\` with the exact \`replaceId\`. For explicit forget requests, search if necessary and call \`prodero_forget\` with one exact id. Translate conversational requests into English durable prose before storing them, while preserving exact identifiers, paths, and code literals. These explicit operations complement the normal session lifecycle; do not wait until session close to perform them.

Project Skills are read from Versioned \`.prodero/skills/\` and Git-ignored Local \`.prodero/local/skills/\`. Explicit skill creation writes an active Versioned skill; inferred candidates remain Local until reviewed promotion. Existing active Local skills are also eligible for retrieval. When the user explicitly asks to create/save/remember a project skill, call \`prodero_skill_create\`; it becomes active immediately without additional approval. Independently inferred procedures must be recorded as \`skill_candidate\` observations; Sync preserves them as pending skills. ${SKILL_EXECUTION_ROUTING} Use \`prodero_skill_review\` to promote or dismiss candidates only on user intent. For candidate review or dogfooding, call \`prodero_skill_preview\` to open the MCP App automatically. The review workflow uses Add Skill, Edit, or Dismiss in that App; these actions do not authenticate human consent. Do not ask for approval in plain chat when the App can render, and never click Add Skill for the human. Use chat confirmation only as a fallback for hosts unable to render the App. Candidate and dismissed skills are excluded from normal context. These are repository procedures, not host/global skills.

Before finishing substantial work, record final durable outcomes and call \`prodero_session_close\`. Session close synchronizes observations into Local Knowledge deterministically; the next prepare recovers any pending synchronization. Sync Memory is a separate user-initiated workflow for transforming and sharing memory. Use prodero_sync to analyze, then prodero_memory_sync to select and process one bundle at a time. Never initiate it from session close. No additional work session is needed for this workflow. Clean selected Local transformations may apply. Keep the exact-preview review step for Versioned changes, promotion and semantic limitations. This is a workflow safeguard, not an authenticated authorization boundary.
`;
