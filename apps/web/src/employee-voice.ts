import { z } from 'zod';

/** Owner-selected speaking identity, independent of the expert's runtime or model. */
export const EmployeeVoiceSchema = z
  .object({
    provider: z.enum(['browser', 'piper', 'kokoro']),
    id: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((id) => !/[\p{Cc}\u2028\u2029]/u.test(id), 'Choose a voice identifier'),
  })
  .strict();
export type EmployeeVoice = z.infer<typeof EmployeeVoiceSchema>;
