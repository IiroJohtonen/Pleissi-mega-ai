import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PASSWORD = "Testi-salasana1";
export const TEST_INTERNAL_TOKEN = "test-internal-token";
export const ADMIN_EMAIL = "demo@pohjantahti-isannointi.fi";
export const MANAGER_EMAIL = "hanna.lehtonen@pohjantahti-isannointi.fi";
export const OTHER_MANAGER_EMAIL = "mikko.rantanen@pohjantahti-isannointi.fi";
export const SERVICE_EMAIL = "elina.koskinen@pohjantahti-isannointi.fi";

export type TestServer = {
  url: string;
  dataDir: string;
  output: () => string;
  stop: () => Promise<void>;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export function tempDir(prefix = "kotilo-test-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// Käynnistää palvelimen omana prosessinaan tyhjään (tai annettuun) datakansioon. Gmail ja AI ovat pois
// päältä, joten testit eivät lähetä postia eivätkä kutsu ulkoisia palveluja.
export async function startServer(options: { dataDir?: string; env?: Record<string, string> } = {}): Promise<TestServer> {
  const dataDir = options.dataDir ?? await tempDir();
  const port = await freePort();
  let output = "";

  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DATA_DIR: dataDir,
      GMAIL_DISABLED: "1",
      ANTHROPIC_API_KEY: "",
      INITIAL_PASSWORD: PASSWORD,
      INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
      DEFAULT_COMPANY_ID: "demo-company",
      AUTHORIZED_COMPANY_IDS: "demo-company",
      BACKUP_DIR: "",
      CLAMAV_HOST: "",
      CORS_ORIGINS: "",
      APP_URL: "",
      TRUST_PROXY: "",
      RATE_LIMIT_PER_MINUTE: "",
      AUTH_RATE_LIMIT: "",
      ...options.env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Palvelin sammui käynnistyksessä:\n${output}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      // Palvelin ei vielä kuuntele.
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`Palvelin ei käynnistynyt ajoissa:\n${output}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return {
    url,
    dataDir,
    output: () => output,
    stop: async () => {
      child.kill();
      await exited;
    }
  };
}

export type ApiResult = { status: number; data: any; headers: Headers };

export async function call(
  server: TestServer, token: string | null, method: string, route: string, body?: unknown,
  headers: Record<string, string> = {}
): Promise<ApiResult> {
  const response = await fetch(`${server.url}/api${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Vastaus ei ole JSON-muotoa (esim. ladattava tiedosto).
  }
  return { status: response.status, data, headers: response.headers };
}

// Simuloi palvelimen oman postintuonnin kutsua: /inbound/messages hyväksyy vain sisäisen tunnisteen.
export function inbound(server: TestServer, _token: string | null, body: unknown) {
  return call(server, null, "POST", "/inbound/messages", body, { "x-internal-token": TEST_INTERNAL_TOKEN });
}

export async function login(server: TestServer, email: string, password = PASSWORD): Promise<string> {
  const result = await call(server, null, "POST", "/auth/login", { email, password });
  if (result.status !== 200) throw new Error(`Kirjautuminen epäonnistui (${email}): ${JSON.stringify(result.data)}`);
  return result.data.token;
}

export async function userByEmail(server: TestServer, token: string, email: string) {
  const users = (await call(server, token, "GET", "/users")).data as { id: string; name: string; email: string; role: string }[];
  const user = users.find(item => item.email === email);
  if (!user) throw new Error(`Käyttäjää ${email} ei löytynyt.`);
  return user;
}

export function localDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("sv-SE");
}
