import { z } from 'zod';

// Arm names follow the credential-name discipline (registry keys interleave).
const NAME_RE = /^[a-z0-9_]+$/;

/** Tag-vs-SHA disambiguation is registration's job (D3's
 *  resolveSuperpowersRef); the schema admits any non-empty ref or "none". */
export const ArmSuperpowersSchema = z.union([
  z.literal('none'),
  z.string().min(1),
]);

export const ArmSchema = z
  .object({
    schema_version: z.literal(1),
    name: z.string().regex(NAME_RE),
    agent: z.string().min(1),
    credential: z.string().min(1),
    superpowers: ArmSuperpowersSchema,
    // Validated against the os-target vocabulary at registration; "windows"
    // parses and is a registration error (parent non-goal).
    os: z.string().min(1).optional(),
    labels: z.record(z.string()).optional(),
  })
  .strict();
export type Arm = z.infer<typeof ArmSchema>;
