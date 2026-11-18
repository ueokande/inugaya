import { z } from "zod";

export const actionReferences = z.object({
  references: z.array(
    z.object({
      reference: z.string(),
      path: z.string(),
      line: z.number().int().positive(),
      url: z.string().url(),
    }),
  ),
});

export const isFullSha = (reference: string): boolean =>
  /@[a-fA-F0-9]{40}$/.test(reference);
