import { z } from 'zod';

/** Shared base for non-integer numeric contract fields: YAML `.inf` parses to
 *  Infinity and zod's plain number admits it, but the digest (RFC 8785) and
 *  report byte-stability cannot represent non-finite values, so they must
 *  reject at the schema boundary. Integer fields already reject via .int().
 *  Chain the usual constraints on top (.positive(), .min(), …). */
export const FiniteNumberSchema = z.number().finite();
