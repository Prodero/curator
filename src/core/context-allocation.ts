/** Resource allocation only: applicability, authority and ranking remain in Core retrieval. */
export const REQUIRED_HARD_TOKENS = 16_000;
export const REQUIRED_HARD_ITEMS = 128;
export const RELEVANT_HARD_ITEMS = 128;
export const SKILL_HARD_TOKENS = 1_500;
export type AllocationConstraint = 'total-capacity' | 'required-token-ceiling' | 'required-item-ceiling' | 'relevant-item-ceiling' | 'skill-token-ceiling' | 'skill-item-ceiling';
export class ContextAllocation {
  used = 0;
  requiredTokens = 0;
  requiredItems = 0;
  skillTokens = 0;
  skillItems = 0;
  relevantItems = 0;
  constructor(readonly total:number, readonly reserve:number) {}
  get remaining() { return Math.max(0,this.total-this.used); }
  take(bucket:'required'|'relevant'|'skill', cost:number):AllocationConstraint|null {
    if(bucket==='required' && this.requiredTokens+cost>REQUIRED_HARD_TOKENS)return 'required-token-ceiling';
    if(bucket==='required' && this.requiredItems>=REQUIRED_HARD_ITEMS)return 'required-item-ceiling';
    if(bucket==='relevant' && this.relevantItems>=RELEVANT_HARD_ITEMS)return 'relevant-item-ceiling';
    if(bucket==='skill' && this.skillItems>=4)return 'skill-item-ceiling';
    if(bucket==='skill' && this.skillTokens+cost>SKILL_HARD_TOKENS)return 'skill-token-ceiling';
    if(cost>this.remaining)return 'total-capacity';
    this.used+=cost;
    if(bucket==='required'){this.requiredTokens+=cost;this.requiredItems++;}
    if(bucket==='relevant')this.relevantItems++;
    if(bucket==='skill'){this.skillTokens+=cost;this.skillItems++;}
    return null;
  }
}
/** Approximate information novelty, not semantic equivalence. Never applied to Required. */
export function marginalValue(words:string[], query:Set<string>, supplied:Set<string>, rankScore:number, peakScore:number) {
  const content=[...new Set(words.filter(t=>!query.has(t)&&!/^\d+$/.test(t)))];
  const novel=content.filter(t=>!supplied.has(t));
  const fraction=content.length?novel.length/content.length:0;
  return {useful:rankScore>=Math.max(12,peakScore*0.3)&&novel.length>=3&&fraction>=0.2,novelTerms:novel.length,novelFraction:fraction};
}
export interface AllocationDiagnostics {
  version:2;
  required:{demandItems:number;demandTokens:number;selectedItems:number;selectedTokens:number;reserveTokens:number;borrowedTokens:number;complete:boolean;hardTokens:number;hardItems:number};
  relevant:{candidates:number;selected:number;softTarget:number;hardItems:number;beyondTarget:number;omissions:{capacity:number;safety:number;marginalValue:number};stopReason:string};
  skills:{candidates:number;selected:number;tokens:number;protectedTokens:number;omitted:Array<{id:string;reason:string;estimatedTokens:number}>};
  unusedTokens:number;
}
