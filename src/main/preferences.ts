import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Choices made in the app's own UI, as opposed to config.json, which the user edits by hand. */
export interface Preferences {
  /** When jobs the model submitted finish, report them back to it in a new turn. */
  hfssAutoAnalyze: boolean;
}

const DEFAULTS: Preferences = { hfssAutoAnalyze: true };

export class PreferenceStore {
  private values: Preferences = { ...DEFAULTS };

  constructor(private readonly path: string) {}

  get current(): Preferences {
    return this.values;
  }

  /** A missing or damaged file means the defaults: these are conveniences, not settings to lose sleep over. */
  async load(): Promise<Preferences> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<Preferences>;
      this.values = {
        hfssAutoAnalyze: typeof parsed.hfssAutoAnalyze === "boolean" ? parsed.hfssAutoAnalyze : DEFAULTS.hfssAutoAnalyze,
      };
    } catch {
      this.values = { ...DEFAULTS };
    }
    return this.values;
  }

  async set(change: Partial<Preferences>): Promise<void> {
    this.values = { ...this.values, ...change };
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.values, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
  }
}
