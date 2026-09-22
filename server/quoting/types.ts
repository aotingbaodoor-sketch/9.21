import type { Calculation, QuoteInput } from "../../shared/quoting.ts";

export type QuoteRow = {
  id: string;
  project_id: string;
  number: number;
  version: number;
  status: string;
  input: QuoteInput;
  snapshot: Calculation;
  customer_snapshot: { company: string; contact: string; email: string; country: string };
  reason: string;
  created_at: Date;
  created_by: string;
  previous_total: string | null;
};
