import { z } from "zod";

export const pingResponse = z.object({
  pong: z.literal(true),
  ts: z.string().datetime(),
  spec: z.string(),
});

export type PingResponse = z.infer<typeof pingResponse>;
