import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar } from "../ui/Avatar";

// What the api's login_error codes mean (server/auth.ts). The words live here, not in the
// URL, so a crafted link can't put its own text on this page.
const ERRORS: Record<string, string> = {
  access_denied: "Sign-in was cancelled.",
  expired: "Sign-in took too long or was interrupted. Please try again.",
  login_failed: "Sign-in didn't work. Please try again.",
};

// Shown when nobody is signed in — LibreChat's login layout: logo on top, a centered card,
// a footer. "Continue" goes to the sign-in page (Keycloak, styled to match), which asks for
// the password; the app itself never sees it.
export function LoginScreen({ onSignIn, error }: { onSignIn: () => void; error?: string }) {
  const [redirecting, setRedirecting] = useState(false);
  // Own keys only: "?login_error=__proto__" must not pick up Object.prototype.
  const message = error ? (Object.hasOwn(ERRORS, error) ? ERRORS[error] : ERRORS.login_failed) : undefined;

  // Back from the sign-in page: browsers may restore this page as it was (back/forward
  // cache) — with the button still saying "Redirecting…". Make it usable again.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => e.persisted && setRedirecting(false);
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  return (
    <div className="relative flex min-h-dvh flex-col bg-surface-primary text-text-primary">
      <div className="mt-6 flex h-10 w-full justify-center">
        <Avatar role="assistant" size="md" />
      </div>

      <main className="flex flex-grow items-center justify-center">
        <div className="w-full max-w-sm overflow-hidden px-6 py-4 sm:max-w-md sm:rounded-lg">
          <h1 className="mb-2 text-center text-3xl font-semibold">Welcome to seyl-ai</h1>
          <p className="mb-6 text-center text-sm text-text-secondary">Your AI assistant, running on this PC. Sign in to continue.</p>

          {message && (
            <div role="alert" className="mb-4 rounded-2xl border border-red-500 bg-red-500/10 px-3 py-2 text-sm text-text-primary">
              {message}
            </div>
          )}

          <button
            type="button"
            disabled={redirecting}
            onClick={() => {
              setRedirecting(true);
              onSignIn();
            }}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[rgb(var(--green-700))] px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-[rgb(var(--green-600))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--green-600))] focus-visible:ring-offset-2 focus-visible:ring-offset-surface-primary disabled:opacity-60"
          >
            {redirecting && <LoaderCircle className="size-4 animate-spin" />}
            {redirecting ? "Redirecting…" : "Continue"}
          </button>
        </div>
      </main>

      <footer className="px-4 pb-4 text-center text-xs text-text-tertiary">
        seyl-ai runs locally on your PC · your conversations stay on this machine
      </footer>
    </div>
  );
}
