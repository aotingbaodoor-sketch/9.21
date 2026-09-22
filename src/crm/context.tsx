import { createContext, useContext } from "react";
import type { Settings, User } from "../../shared/contracts.ts";
export type Session = {
  user: User;
  settings: Settings;
  revision: number;
  refresh: () => void;
  notify: (message: string) => void;
  reloadSession: () => Promise<void>;
};
export const SessionContext = createContext<Session | null>(null);
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("Session missing");
  return value;
}
