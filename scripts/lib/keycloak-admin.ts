// Keycloak's admin API and admin ("master") realm are NOT published through the app's nginx
// (only the ai-agent realm is). Admin scripts talk to Keycloak directly, on this PC only:
//   - KEYCLOAK_URL, if set;
//   - else (Kubernetes) this run's own `kubectl port-forward`, on a free local port — never
//     shared with another script, whose tunnel could close in the middle of this run;
//   - else (Docker Compose) http://127.0.0.1:8081/auth, where Compose publishes it (loopback).

import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";

const COMPOSE = "http://127.0.0.1:8081/auth";

const reachable = (url: string) =>
  fetch(`${url}/realms/master`, { signal: AbortSignal.timeout(1500) }).then(
    (res) => res.ok,
    () => false,
  );

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
      .once("error", reject)
      .listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      });
  });

export async function keycloakAdmin(): Promise<{ url: string; close: () => void }> {
  if (process.env.KEYCLOAK_URL) return { url: process.env.KEYCLOAK_URL, close: () => {} };

  const port = await freePort();
  const url = `http://127.0.0.1:${port}/auth`;
  const forward = spawn("kubectl", ["-n", "ai-agent", "port-forward", "--address", "127.0.0.1", "svc/keycloak", `${port}:8080`], {
    stdio: "ignore",
  });
  let gone = false; // no kubectl, or no cluster (e.g. running Docker Compose)
  forward.on("error", () => (gone = true));
  forward.on("exit", () => (gone = true));
  const close = () => void forward.kill();
  process.on("exit", close);
  for (let i = 0; i < 40 && !gone; i++) {
    if (await reachable(url)) return { url, close };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  close();

  if (await reachable(COMPOSE)) return { url: COMPOSE, close: () => {} };
  throw new Error("Keycloak's admin API isn't reachable. Is the stack running? (Or set KEYCLOAK_URL.)");
}
