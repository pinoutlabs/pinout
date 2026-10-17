/**
 * Host-platform gate.
 *
 * libgpiod talks to the Linux GPIO character device (/dev/gpiochip*). On
 * darwin/win32 every command operation must refuse to run instead of invoking
 * a tool that cannot work. Backend construction is deliberately allowed on
 * any platform so tooling can still describe, plan, and register the device
 * (for example generating a device list on a developer laptop).
 */
import { platformUnsupportedError } from './errors.js';

export function isLinux(platform: string = process.platform): boolean {
  return platform === 'linux';
}

export function assertLinux(operation: string, platform: string = process.platform): void {
  if (!isLinux(platform)) {
    throw platformUnsupportedError(operation, platform);
  }
}
