/** OS advisory file lock: the helper holds one descriptor until the parent closes its pipe. */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

// flock releases on process death, including SIGKILL. The file is never renamed/unlinked: all
// waiters must lock the same inode. Metadata records the owning relay pid and age for recovery.
const HELPER = `
import fcntl, json, os, sys, time
file, parent = sys.argv[1], int(sys.argv[2])
fd = os.open(file, os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
with os.fdopen(fd, 'r+') as stream:
    try: old = json.load(stream)
    except (ValueError, EOFError): old = {}
    if old.get('pid'):
        try: os.kill(old['pid'], 0); alive = True
        except ProcessLookupError: alive = False
        if not alive:
            age = time.time() * 1000 - old.get('at', 0)
            if age < 1000: time.sleep((1000 - age) / 1000)
    def record(value):
        stream.seek(0); stream.truncate(); json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
    record({'pid': parent, 'at': int(time.time() * 1000)})
    print('locked', flush=True)
    sys.stdin.buffer.read()
    record({'pid': None, 'releasedAt': int(time.time() * 1000)})
`;
const held = new AsyncLocalStorage<{ name: string; alive: () => boolean }>();
export function assertStateLockHeld(name: string): void {
  const lock = held.getStore();
  if (!lock || lock.name !== name || !lock.alive()) throw new Error(`state lock lost: ${name}`);
}
export async function withStateLock<T>(dir: string, name: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const helper = spawn("python3", ["-c", HELPER, path.join(dir, `${name}.lock`), String(process.pid)], { stdio: ["pipe", "pipe", "pipe"] });
  let errorText = "";
  helper.stdin.on("error", () => undefined);
  helper.stderr.on("data", (value) => { errorText += value.toString(); });
  const exited = new Promise<void>((resolve) => helper.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { helper.kill("SIGTERM"); reject(new Error(`state lock busy: ${name}`)); }, 240_000);
      helper.once("error", (error) => { clearTimeout(timeout); reject(error); });
      helper.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`state lock helper exited ${code}: ${errorText}`)); });
      helper.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
    });
    return await held.run({ name, alive: () => helper.exitCode === null && helper.signalCode === null && helper.pid !== undefined }, fn);
  } finally {
    helper.stdin.end();
    const cleanup = setTimeout(() => helper.kill("SIGKILL"), 2_000);
    await exited;
    clearTimeout(cleanup);
  }
}
