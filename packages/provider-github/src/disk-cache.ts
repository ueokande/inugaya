import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

const maxCacheBytes = 512 * 1024 * 1024;
const maxEntryBytes = 32 * 1024 * 1024;
const cacheFile = /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]+\.tmp)?$/;

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isPrivate(stat: fs.Stats): boolean {
  return stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
}

export class GitHubDiskCache {
  private readonly directory: string;
  private readonly credential: string;
  private ready?: Promise<void>;
  private usage?: Promise<{ bytes: number }>;

  constructor(directory: string, token: string) {
    this.directory = path.resolve(directory, "inugaya-github-v1");
    this.credential = digest(token);
  }

  forRepository(id: string) {
    const scope = JSON.stringify(["github.com", id, this.credential]);
    const file = (key: string) =>
      path.join(this.directory, `${digest(`${scope}:${key}`)}.json`);
    return {
      read: (key: string) => this.read(file(key)),
      write: (key: string, data: unknown) => this.write(file(key), data),
    };
  }

  private async prepare(): Promise<void> {
    if (!process.getuid)
      throw new Error("Private cache permissions are unavailable.");
    await fsPromises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fsPromises.lstat(this.directory);
    if (!stat.isDirectory() || !isPrivate(stat)) {
      throw new Error("The GitHub cache directory must be private.");
    }
  }

  private async read(file: string): Promise<unknown> {
    try {
      this.ready ??= this.prepare();
      await this.ready;
      const handle = await fsPromises.open(
        file,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || !isPrivate(stat) || stat.size > maxEntryBytes)
          return;
        const text = await handle.readFile("utf8");
        const body = text.slice(65);
        if (text[64] === "\n" && text.slice(0, 64) === digest(body)) {
          return JSON.parse(body);
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Cache I/O and corrupt entries are recoverable misses.
    }
  }

  private async measureUsage(): Promise<{ bytes: number }> {
    let bytes = 0;
    for await (const entry of await fsPromises.opendir(this.directory)) {
      if (entry.isFile() && cacheFile.test(entry.name)) {
        bytes +=
          (
            await fsPromises
              .lstat(path.join(this.directory, entry.name))
              .catch(() => undefined)
          )?.size ?? 0;
      }
    }
    return { bytes };
  }

  private async write(file: string, data: unknown): Promise<void> {
    try {
      this.ready ??= this.prepare();
      await this.ready;
      const body = JSON.stringify(data);
      const bytes = Buffer.byteLength(body) + 65;
      if (bytes > maxEntryBytes) return;
      this.usage ??= this.measureUsage();
      const usage = await this.usage;
      if (usage.bytes + bytes > maxCacheBytes) return;
      usage.bytes += bytes;
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await fsPromises.writeFile(temporary, `${digest(body)}\n${body}`, {
          flag: "wx",
          mode: 0o600,
        });
        await fsPromises.rename(temporary, file);
      } catch {
        usage.bytes -= bytes;
        await fsPromises.rm(temporary, { force: true }).catch(() => {});
      }
    } catch {
      // A full or unavailable cache must not prevent scanning.
    }
  }
}

export type RepositoryDiskCache = ReturnType<GitHubDiskCache["forRepository"]>;
