/** Neutral memory copy shared by Open and text clients. Core owns decisions. */
type Data = Record<string, any>;
export const MEMORY_COPY = {
 automatic: 'Prodero remembers automatically. Sessions save useful knowledge into Local Knowledge when they close.',
 incompleteProvenance: 'Some provenance fields are incomplete; this is not proof of lost history. Existing records are preserved. Verify actual sources before proposing repairs; diagnostics do not infer or backfill provenance.',
};

export function memoryOpenPresentation(project:Data) {
 const headline=project.knowledgeCount>0?'Memory saves automatically.':'Memory is ready to learn';
 const notes=[MEMORY_COPY.automatic];
 if(project.knowledgeCount===0)notes.push('No current memories yet. Normal work will build Local Knowledge.');
 return {headline,notes};
}
