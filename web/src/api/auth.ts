import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, APIError } from "./client";
import type { User } from "./types";

/** Current user, or null when unauthenticated (401 is not an error here). */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async (): Promise<User | null> => {
      try {
        return await api.me();
      } catch (e) {
        if (e instanceof APIError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useAuthConfig() {
  return useQuery({ queryKey: ["authConfig"], queryFn: api.authConfig, staleTime: Infinity });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; password: string }) => api.login(v.email, v.password),
    onSuccess: (u: User) => qc.setQueryData(["me"], u),
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.register,
    onSuccess: (u: User) => qc.setQueryData(["me"], u),
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.updateProfile,
    onSuccess: (u: User) => qc.setQueryData(["me"], u),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      qc.setQueryData(["me"], null);
      qc.removeQueries();
    },
  });
}
