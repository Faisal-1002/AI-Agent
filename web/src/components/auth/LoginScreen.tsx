import { LogIn } from "lucide-react";
import { Avatar } from "../ui/Avatar";

// Shown when nobody is signed in. The button starts the OIDC login at the api.
export function LoginScreen({ onSignIn, error }: { onSignIn: () => void; error?: string }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-5 bg-presentation px-4 text-center text-text-primary">
      <Avatar role="assistant" size="lg" />
      <div>
        <h1 className="text-2xl font-medium">seyl-ai</h1>
        <p className="mt-1 text-sm text-text-secondary">Sign in to continue.</p>
      </div>
      <button
        type="button"
        onClick={onSignIn}
        className="flex items-center gap-2 rounded-full bg-text-primary px-5 py-2.5 text-sm font-medium text-surface-primary hover:opacity-90"
      >
        <LogIn className="size-4" />
        Sign in
      </button>
      {error && <p className="max-w-sm text-sm text-text-destructive">Sign-in failed: {error}</p>}
    </div>
  );
}
