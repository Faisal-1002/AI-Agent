import { spawn } from "node:child_process";
import { connect, createServer, type AddressInfo } from "node:net";

// A private `kubectl port-forward` to a service in the cluster, on a free local port — for scripts
// that run the app's own code on this PC against the cluster's database or gateway.

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
      .once("error", reject)
      .listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      });
  });

const open = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1")
      .once("connect", () => {
        socket.destroy();
        resolve(true);
      })
      .once("error", () => resolve(false));
  });

export async function portForward(service: string, remotePort: number): Promise<{ port: number; close: () => void }> {
  const port = await freePort();
  const forward = spawn("kubectl", ["-n", "ai-agent", "port-forward", "--address", "127.0.0.1", `svc/${service}`, `${port}:${remotePort}`], { stdio: "ignore" });
  let gone = false;
  forward.on("error", () => (gone = true));
  forward.on("exit", () => (gone = true));
  const close = () => void forward.kill();
  process.on("exit", close);
  for (let i = 0; i < 40 && !gone; i++) {
    if (await open(port)) return { port, close };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  close();
  throw new Error(`Couldn't reach svc/${service} in the cluster. Is the stack running?`);
}
