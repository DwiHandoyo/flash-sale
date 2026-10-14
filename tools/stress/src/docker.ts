import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The repository root, where docker-compose.yml lives. */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export interface ComposeOptions {
  /** Called with each line the command writes to stderr. */
  readonly onStderrLine?: (line: string) => void;
}

/** Runs `docker compose <args>` and resolves with its stdout. Rejects with its output on failure. */
export function compose(args: readonly string[], options: ComposeOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let partialLine = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (!options.onStderrLine) return;
      const lines = (partialLine + text).split('\n');
      partialLine = lines.pop() ?? '';
      for (const line of lines) options.onStderrLine(line);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`docker compose ${args.join(' ')} exited with ${code}\n${stderr}${stdout}`),
        );
    });
  });
}
