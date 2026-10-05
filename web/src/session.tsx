import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImpoClient } from "./api/client";
import type { Profile } from "./api/types";
export interface Session {
  api: ImpoClient;
  account: string;
  email: string;
  signOut: () => Promise<void>;
  manageAccount: () => void;
  fixture: boolean;
}
export const SessionContext = createContext<Session | null>(null);
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Session unavailable");
  return session;
}
export function useApiQuery<T>(path: string, enabled = true) {
  const { api } = useSession();
  return useQuery({
    queryKey: [path],
    queryFn: ({ signal }) => api.get<T>(path, signal),
    enabled,
  });
}
export function useProfile() {
  const { api } = useSession();
  return useQuery({
    queryKey: ["/profile"],
    queryFn: ({ signal }) => api.get<Profile>("/profile", signal),
    staleTime: 0,
    refetchInterval: 60000,
  });
}
