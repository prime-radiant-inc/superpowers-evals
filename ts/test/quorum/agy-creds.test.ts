import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { backupCredential, setCredPathForTesting } from "../../src/quorum/agy-creds.ts";

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-creds-test-"));
}

function write(p: string, obj: unknown): void {
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
}

afterEach(() => {
  setCredPathForTesting(null); // restore default cred path
});

describe("backupCredential / verifyOrRestore", () => {
  test("corrupt creds restored", () => {
    const tmp = makeTmp();
    const creds = path.join(tmp, ".gemini", "oauth_creds.json");
    fs.mkdirSync(path.dirname(creds), { recursive: true });
    write(creds, { access_token: "good", refresh_token: "r" });
    setCredPathForTesting(creds);

    const b = backupCredential();
    expect(b).not.toBeNull();
    fs.writeFileSync(creds, '{"access_token": "tru', "utf8"); // half-written kill
    b!.verifyOrRestore();
    expect(JSON.parse(fs.readFileSync(creds, "utf8")).access_token).toBe("good"); // restored
  });

  test("legitimate refresh not restored", () => {
    const tmp = makeTmp();
    const creds = path.join(tmp, ".gemini", "oauth_creds.json");
    fs.mkdirSync(path.dirname(creds), { recursive: true });
    write(creds, { access_token: "old", refresh_token: "r" });
    setCredPathForTesting(creds);

    const b = backupCredential();
    expect(b).not.toBeNull();
    write(creds, { access_token: "rotated", refresh_token: "r" }); // valid refresh
    b!.verifyOrRestore();
    expect(JSON.parse(fs.readFileSync(creds, "utf8")).access_token).toBe("rotated"); // left alone
  });

  test("restore failure does not raise", () => {
    const tmp = makeTmp();
    const creds = path.join(tmp, ".gemini", "oauth_creds.json");
    fs.mkdirSync(path.dirname(creds), { recursive: true });
    write(creds, { access_token: "good", refresh_token: "r" });
    setCredPathForTesting(creds);

    const b = backupCredential();
    expect(b).not.toBeNull();
    fs.writeFileSync(creds, "corrupt", "utf8"); // live is corrupt -> restore path
    fs.unlinkSync(b!.backup); // backup gone -> copy would raise; must be swallowed
    expect(() => b!.verifyOrRestore()).not.toThrow(); // best-effort
  });

  test("missing creds is noop", () => {
    const tmp = makeTmp();
    setCredPathForTesting(path.join(tmp, "nope.json"));
    expect(backupCredential()).toBeNull(); // nothing to protect
  });

  test("backup file cleaned up on valid json", () => {
    const tmp = makeTmp();
    const creds = path.join(tmp, ".gemini", "oauth_creds.json");
    fs.mkdirSync(path.dirname(creds), { recursive: true });
    write(creds, { access_token: "ok", refresh_token: "r" });
    setCredPathForTesting(creds);

    const b = backupCredential();
    expect(b).not.toBeNull();
    const backupPath = b!.backup;
    expect(fs.existsSync(backupPath)).toBe(true);
    b!.verifyOrRestore();
    expect(fs.existsSync(backupPath)).toBe(false); // temp file removed even on no-op path
  });

  test("backup file cleaned up after restore", () => {
    const tmp = makeTmp();
    const creds = path.join(tmp, ".gemini", "oauth_creds.json");
    fs.mkdirSync(path.dirname(creds), { recursive: true });
    write(creds, { access_token: "good", refresh_token: "r" });
    setCredPathForTesting(creds);

    const b = backupCredential();
    expect(b).not.toBeNull();
    const backupPath = b!.backup;
    fs.writeFileSync(creds, "not json at all", "utf8");
    b!.verifyOrRestore();
    expect(fs.existsSync(backupPath)).toBe(false); // temp file removed after restore
  });
});
