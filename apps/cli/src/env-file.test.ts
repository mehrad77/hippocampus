import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv as nodeParseEnv } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvOrigins, loadEnv, parseEnv, readEnvFile, updateEnvFile } from "./env-file.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hippo-env-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("user env file", () => {
  it("creates the file readable only by you", async () => {
    const file = join(tmp, "cfg", "env");
    await updateEnvFile(file, { HIPPO_LLM_PROVIDER: "lmstudio", HIPPO_LLM_API_KEY: "sk-test-123456" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await readEnvFile(file)).toEqual({ HIPPO_LLM_PROVIDER: "lmstudio", HIPPO_LLM_API_KEY: "sk-test-123456" });
    // No temp files left behind by the atomic write.
    expect(readdirSync(join(tmp, "cfg"))).toEqual(["env"]);
  });

  it("updates in place, keeping comments, order and unrelated lines", async () => {
    const file = join(tmp, "env");
    writeFileSync(file, "# my settings\nHIPPO_VAULT=~/vaults/lisbon-arc\n\n# model\nHIPPO_LLM_MODEL=old\nHIPPO_EMBED_MODEL=bge-m3\n", { mode: 0o644 });
    await updateEnvFile(file, { HIPPO_LLM_MODEL: "qwen/qwen3.5-9b", HIPPO_EMBED_MODEL: null, HIPPO_LLM_BASE_URL: "http://127.0.0.1:1234/v1", HIPPO_VAULT: undefined });
    expect(readFileSync(file, "utf8")).toBe("# my settings\nHIPPO_VAULT=~/vaults/lisbon-arc\n\n# model\nHIPPO_LLM_MODEL=qwen/qwen3.5-9b\nHIPPO_LLM_BASE_URL=http://127.0.0.1:1234/v1\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("quotes values so node reads them back exactly", async () => {
    const file = join(tmp, "env");
    const values = { A: "two words", B: "has#hash", C: "it's", D: 'say "hi"', E: "plain-value_1.2" };
    await updateEnvFile(file, values);
    const text = readFileSync(file, "utf8");
    expect(nodeParseEnv(text)).toMatchObject(values);
    expect(parseEnv(text)).toMatchObject(values);
  });

  it("rejects line breaks without echoing the value", async () => {
    const file = join(tmp, "env");
    const secret = "sk-secret-value\nHIPPO_INJECTED=1";
    const err = await updateEnvFile(file, { HIPPO_LLM_API_KEY: secret }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("HIPPO_LLM_API_KEY");
    expect((err as Error).message).not.toContain("sk-secret-value");
    await expect(updateEnvFile(file, { "BAD KEY": "x" })).rejects.toThrow(/invalid setting name/);
  });
});

describe("precedence", () => {
  const keys = ["HIPPO_TEST_SHELL", "HIPPO_TEST_CWD", "HIPPO_TEST_USER"];
  afterEach(() => {
    for (const k of keys) delete process.env[k];
  });

  it("is shell > cwd .env > user env file, and reports what overrides the user file", () => {
    process.env.HIPPO_TEST_SHELL = "from-shell";
    const cwdFile = join(tmp, ".env");
    const userFile = join(tmp, "user-env");
    writeFileSync(cwdFile, "HIPPO_TEST_SHELL=from-cwd\nHIPPO_TEST_CWD=from-cwd\n");
    writeFileSync(userFile, "HIPPO_TEST_SHELL=from-user\nHIPPO_TEST_CWD=from-user\nHIPPO_TEST_USER=from-user\n");
    const origins = loadEnv({ cwdFile, userFile: () => userFile });
    expect([process.env.HIPPO_TEST_SHELL, process.env.HIPPO_TEST_CWD, process.env.HIPPO_TEST_USER]).toEqual(["from-shell", "from-cwd", "from-user"]);
    expect(origins.origin("HIPPO_TEST_SHELL")).toBe("shell");
    expect(origins.origin("HIPPO_TEST_CWD")).toBe("cwd");
    expect(origins.origin("HIPPO_TEST_USER")).toBe("user");
    expect(origins.overriddenBy(keys)).toEqual(["HIPPO_TEST_SHELL", "HIPPO_TEST_CWD"]);
  });

  it("mirrors saved settings into the process unless the shell or .env wins", () => {
    const env: Record<string, string | undefined> = { HIPPO_LLM_MODEL: "shell-model", HIPPO_LLM_BASE_URL: "http://127.0.0.1:1234/v1" };
    const origins = new EnvOrigins(new Set(["HIPPO_LLM_MODEL"]), new Set());
    origins.apply({ HIPPO_LLM_MODEL: "saved", HIPPO_LLM_PROVIDER: "ollama", HIPPO_LLM_BASE_URL: null, HIPPO_LLM_API_KEY: undefined }, env);
    expect(env).toEqual({ HIPPO_LLM_MODEL: "shell-model", HIPPO_LLM_PROVIDER: "ollama" });
  });
});
