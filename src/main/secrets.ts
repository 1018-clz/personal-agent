import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Electron's safeStorage in the app (Windows DPAPI, tied to this user), a stand-in in tests. */
export interface Cipher {
  available(): Promise<boolean>;
  encrypt(text: string): Promise<Buffer>;
  /** stale: readable, but the system has a newer key, so it should be encrypted again. */
  decrypt(data: Buffer): Promise<{ text: string; stale?: boolean }>;
}

/**
 * API keys, encrypted, in their own file next to config.json. Both are in %APPDATA%, which
 * sandboxed commands cannot read; the encryption also keeps a copied file or a backup useless
 * on another account or machine.
 */
export class SecretStore {
  constructor(
    private readonly path: string,
    private readonly cipher: Cipher,
  ) {}

  async get(name: string): Promise<string | undefined> {
    const stored = (await this.read())[name];
    if (typeof stored !== "string") return undefined;
    let text: string;
    let stale: boolean | undefined;
    try {
      ({ text, stale } = await this.cipher.decrypt(Buffer.from(stored, "base64")));
    } catch {
      // Encrypted for another Windows account, or the file was damaged: as good as not saved.
      return undefined;
    }
    // Only a better copy: the old one still works, so failing to save it changes nothing.
    if (stale) await this.set(name, text).catch(() => {});
    return text;
  }

  async set(name: string, value: string): Promise<void> {
    if (!(await this.cipher.available())) throw new Error("系统加密不可用，无法安全保存 API Key");
    const encrypted = await this.cipher.encrypt(value);
    const all = await this.read();
    all[name] = encrypted.toString("base64");
    await this.write(all);
  }

  async delete(name: string): Promise<void> {
    const all = await this.read();
    if (!(name in all)) return;
    delete all[name];
    await this.write(all);
  }

  private async read(): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private async write(all: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
  }
}
