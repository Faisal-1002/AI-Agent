import { useEffect, useState } from "react";
import type { User } from "../../../shared/chat";
import { api } from "../lib/api";

type Auth = { status: "loading" } | { status: "signed-out"; error?: string } | { status: "signed-in"; user: User };

// Who's signed in? The api answers from its session cookie (the browser never holds tokens).
export function useAuth() {
  const [auth, setAuth] = useState<Auth>({ status: "loading" });

  useEffect(() => {
    const error = new URLSearchParams(window.location.search).get("login_error") ?? undefined;
    if (error) window.history.replaceState(null, "", "/"); // don't keep the error in the address bar
    api
      .me()
      .then(({ user }) => setAuth({ status: "signed-in", user }))
      .catch(() => setAuth({ status: "signed-out", error }));
  }, []);

  const signIn = () => window.location.assign("/api/auth/login");
  const signOut = async () => {
    const { logoutUrl } = await api.logout();
    window.location.assign(logoutUrl); // also ends the session at the identity provider
  };

  return { auth, signIn, signOut };
}
