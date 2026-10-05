import { cp } from "node:fs/promises";
await cp("server/migrations", "build/server/migrations", { recursive: true });
await cp("server/assets", "build/server/assets", { recursive: true });
