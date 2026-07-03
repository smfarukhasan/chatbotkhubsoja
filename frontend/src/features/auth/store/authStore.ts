import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AuthSession, AuthUser } from "../../../shared/types/auth";

type AuthState = {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  activeAccountId: number | null;
  activeFacebookConnectionId: number | null;
  hydrated: boolean;
  setSession: (session: AuthSession) => void;
  setUser: (user: AuthUser) => void;
  setActiveAccountId: (accountId: number | null) => void;
  setActiveFacebookConnectionId: (connectionId: number | null) => void;
  setHydrated: (value: boolean) => void;
  clear: () => void;
};

const resolveDefaultAccountId = (user: AuthUser): number | null =>
  user.memberships.find((membership) => membership.status === "active")?.account_id ?? null;

const hasActiveMembership = (user: AuthUser, accountId: number | null): boolean =>
  Boolean(
    accountId &&
      user.memberships.some((membership) => membership.account_id === accountId && membership.status === "active"),
  );

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      activeAccountId: null,
      activeFacebookConnectionId: null,
      hydrated: false,
      setSession: (session) =>
        set({
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          user: session.user,
          activeAccountId: resolveDefaultAccountId(session.user),
          activeFacebookConnectionId: null,
        }),
      setUser: (user) =>
        set((state) => ({
          user,
          activeAccountId: hasActiveMembership(user, state.activeAccountId)
            ? state.activeAccountId
            : resolveDefaultAccountId(user),
          activeFacebookConnectionId: state.activeFacebookConnectionId,
        })),
      setActiveAccountId: (activeAccountId) => set({ activeAccountId, activeFacebookConnectionId: null }),
      setActiveFacebookConnectionId: (activeFacebookConnectionId) => set({ activeFacebookConnectionId }),
      setHydrated: (hydrated) => set({ hydrated }),
      clear: () =>
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          activeAccountId: null,
          activeFacebookConnectionId: null,
        }),
    }),
    {
      name: "automation-auth",
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        activeAccountId: state.activeAccountId,
        activeFacebookConnectionId: state.activeFacebookConnectionId,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated(true);
      },
    },
  ),
);
