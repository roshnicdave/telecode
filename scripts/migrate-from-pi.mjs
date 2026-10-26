import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { randomBytes } from "node:crypto";

const home = homedir();
const pi = join(home, ".pi", "agent");
const openCodeAuth = join(home, ".local", "share", "opencode", "auth.json");
const secrets = join(home, ".config", "opencode", "secrets");
const telecode = join(home, ".telecode");

function json(path, fallback = {}) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function atomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

const auth = json(join(pi, "auth.json"));
const models = json(join(pi, "models.json"));
const target = json(openCodeAuth);

if (auth.deepseek?.key) target.deepseek = { type: "api", key: auth.deepseek.key };
if (auth["cloudflare-workers-ai"]?.key) {
  target["cloudflare-workers-ai"] = { type: "api", key: auth["cloudflare-workers-ai"].key };
  atomic(join(secrets, "cloudflare-api-token"), `${auth["cloudflare-workers-ai"].key}\n`);
}
const accountID = auth["cloudflare-workers-ai"]?.env?.CLOUDFLARE_ACCOUNT_ID;
if (accountID) atomic(join(secrets, "cloudflare-account-id"), `${accountID}\n`);
const evilKey = models.providers?.["evil-qwen"]?.apiKey;
if (evilKey) {
  target["evil-qwen"] = { type: "api", key: evilKey };
  atomic(join(secrets, "evil-qwen-api-key"), `${evilKey}\n`);
}
atomic(openCodeAuth, `${JSON.stringify(target, null, 2)}\n`);

const passwordPath = join(telecode, "opencode-server-password");
let serverPassword;
try { serverPassword = readFileSync(passwordPath, "utf8").trim(); } catch { serverPassword = randomBytes(32).toString("base64url"); }
atomic(passwordPath, `${serverPassword}\n`);
const client = createOpencodeClient({
  baseUrl: process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4098",
  headers: { authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` },
});
try {
  for (const [providerID, credential] of Object.entries(target)) {
    if (credential?.type === "api" && credential.key) {
      await client.auth.set({ providerID, auth: credential }, { throwOnError: true });
    }
  }
} catch {
  console.log("Credential files are ready; start the OpenCode server and run this migration once more to sync its credential database.");
}

mkdirSync(telecode, { recursive: true });
copyFileSync(join(pi, ".telegram_token"), join(telecode, "telegram-token"));
copyFileSync(join(pi, ".telegram_allowed_ids"), join(telecode, "telegram-allowed-ids"));
chmodSync(join(telecode, "telegram-token"), 0o600);
chmodSync(join(telecode, "telegram-allowed-ids"), 0o600);

console.log("Migrated provider and Telegram credentials without printing secret values.");
