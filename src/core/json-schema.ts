import { z } from 'zod';

/** Preserve the existing draft-7 input contract, including optional defaults. */
export function jsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input', reused: 'inline' });
}
