import { Avatar } from "../ui/Avatar";

// What a new chat shows before the first message.
export function Landing() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 pb-10 text-center">
      <Avatar role="assistant" size="lg" />
      <h1 className="text-2xl font-medium text-text-primary">How can I help you today?</h1>
      <p className="max-w-md text-sm text-text-secondary">
        Ai-Agent can read and search the files in your workspace. Try “What&apos;s in notes.md?”
      </p>
    </div>
  );
}
