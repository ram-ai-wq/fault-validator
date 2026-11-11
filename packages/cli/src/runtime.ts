export function javascriptArgs(
  args: string[],
  bunVersion = process.versions.bun,
): string[] {
  // Match Node's explicit environment and installed-dependency behavior.
  return bunVersion ? ['--no-env-file', '--no-install', ...args] : args;
}
