import { KeyRound, Laptop, LoaderCircle, Plug, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { DeviceInfo, NewDevice } from "../../../../shared/chat";
import { api } from "../../lib/api";
import { envCommands, opencodeConfig } from "../../lib/deviceConfig";
import { CodeBlock } from "../ui/CodeBlock";
import { CopyButton } from "../ui/CopyButton";
import { IconButton } from "../ui/IconButton";

const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "never");

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border-light bg-surface-secondary px-3 py-2">
      <KeyRound className="size-4 shrink-0 text-text-secondary" />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-text-tertiary">{label}</div>
        <code className="block truncate font-mono text-sm" title={value}>
          {value}
        </code>
      </div>
      <CopyButton getText={() => value} label={`Copy ${label}`} className="p-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary" />
    </div>
  );
}

// What a new device shows ONCE: its two secrets, how to set them, and the opencode.json.
function Connected({ device, onDone }: { device: NewDevice; onDone: () => void }) {
  const env = envCommands(device);
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-amber-500/50 bg-amber-500/5 px-3 py-2 text-sm">
        <span className="font-semibold">Copy these now</span> — Seyl keeps only a fingerprint, so they won't be shown again.
      </div>
      <Secret label="Model key (SEYL_API_KEY)" value={device.apiKey} />
      <Secret label="Document-tools token (SEYL_MCP_TOKEN)" value={device.mcpToken} />

      <p className="pt-1 text-sm font-medium">1. On “{device.device.name}”, save them as environment variables</p>
      <CodeBlock language="powershell">{env.powershell}</CodeBlock>
      <CodeBlock language="bash">{env.bash}</CodeBlock>

      <p className="text-sm font-medium">2. Put this in opencode.json (it holds no secrets)</p>
      <p className="-mt-2 text-xs text-text-tertiary">
        OpenCode CLI: in your project folder, or ~/.config/opencode/opencode.json for every project. Works the same for an OpenWork workspace.
      </p>
      <CodeBlock language="json" maxHeight>
        {opencodeConfig(device)}
      </CodeBlock>

      <button type="button" onClick={onDone} className="self-end rounded-xl bg-text-primary px-4 py-2 text-sm font-medium text-surface-primary hover:opacity-90">
        I've copied them
      </button>
    </div>
  );
}

// "Connect a device": Seyl's model gateway and document tools for the OpenCode CLI, OpenWork
// desktop and other apps that can't sign in themselves (server/devices.ts).
export function DevicesPanel({ onClose }: { onClose: () => void }) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<NewDevice>();

  const refresh = useCallback(() => {
    api.devices().then(setDevices).catch((err: Error) => setError(err.message));
  }, []);
  useEffect(refresh, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !created && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, created]);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setCreated(await api.connectDevice(name.trim()));
      setName("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (device: DeviceInfo) => {
    if (!window.confirm(`Disconnect "${device.name}"? Its model key and document-tools token stop working immediately.`)) return;
    try {
      await api.disconnectDevice(device.id);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => !created && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="devices-title"
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl bg-surface-primary shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <div>
            <h2 id="devices-title" className="text-lg font-semibold">
              Devices
            </h2>
            <p className="text-sm text-text-secondary">Use Seyl from the OpenCode CLI, OpenWork desktop and other apps.</p>
          </div>
          {!created && <IconButton icon={X} label="Close" onClick={onClose} />}
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {created ? (
            <Connected device={created} onDone={() => setCreated(undefined)} />
          ) : (
            <>
              <form onSubmit={connect} className="flex gap-2 py-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Device name, e.g. Work laptop"
                  aria-label="Device name"
                  maxLength={60}
                  className="min-w-0 flex-1 rounded-xl border border-border-light bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-medium focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!name.trim() || busy}
                  className="flex items-center gap-1.5 rounded-xl bg-[rgb(var(--green-700))] px-4 py-2 text-sm font-medium text-white hover:bg-[rgb(var(--green-600))] disabled:opacity-50"
                >
                  {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Plug className="size-4" />}
                  Connect
                </button>
              </form>
              {error && <p className="pb-2 text-sm text-text-destructive">{error}</p>}

              <ul className="flex flex-col">
                {devices.length === 0 && <li className="py-6 text-center text-sm text-text-tertiary">No connected devices yet.</li>}
                {devices.map((device) => (
                  <li key={device.id} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover">
                    <Laptop className="size-5 shrink-0 text-text-secondary" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{device.name}</div>
                      <div className="text-xs text-text-tertiary">
                        Connected {when(device.createdAt)} · last used {when(device.lastUsedAt)} · expires {when(device.expiresAt)}
                      </div>
                    </div>
                    <IconButton icon={Trash2} label={`Disconnect ${device.name}`} size="sm" onClick={() => void disconnect(device)} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
