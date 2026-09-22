import type { NextApiRequest, NextApiResponse } from "next";
import { createApp } from "../../server/app.ts";
import { database } from "../../server/db.ts";

const inferredOrigin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";
let app: ReturnType<typeof createApp> | undefined;

function crmApp() {
  if (app) return app;
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for the AUTINBERG CRM API");
  app = createApp(database(process.env.DATABASE_URL), {
    origin: process.env.APP_ORIGIN || inferredOrigin,
    production: process.env.NODE_ENV === "production",
    sessionHours: Number(process.env.SESSION_HOURS || 12),
  });
  return app;
}

export const config = { api: { bodyParser: false } };

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return crmApp()(req, res);
}
