import { spawn } from 'node:child_process';
import process from 'node:process';

export function resolveBrowserCommand(url: string, platform = process.platform): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

export function openBrowser(url: string): void {
  const [command, args] = resolveBrowserCommand(url);
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.once('error', (error) => {
    console.warn(`Could not open the browser automatically: ${error.message}`);
  });
  child.unref();
}
