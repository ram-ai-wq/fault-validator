import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const CONTAINER_ROOT = '/work';
export const CONTAINER_TOOL_DIR = '/tc';
export const RUN_LABEL = 'test-container.run';
const BUN_TOOLS = `${CONTAINER_ROOT}/node_modules/.test-container-tools`;
export const CONTAINER_BUN = `${BUN_TOOLS}/node_modules/.bin/bun`;
const DEFAULT_BUN_VERSION = '1.4.4';

export type DockerSettings = {
  engine: 'docker' | 'podman';
  image: string;
  pull: 'always' | 'if-missing' | 'never';
  extraArgs: string[];
  hostGateway: boolean;
};

export function resolveImage(image: string, playwrightVersion: string): string {
  return image === 'auto'
    ? `mcr.microsoft.com/playwright:v${playwrightVersion}-noble`
    : image;
}

export function toContainerPath(hostPath: string, root: string): string {
  const rel = relative(resolve(root), resolve(hostPath));
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error(
      `TC_E_CONFIG_INVALID: ${hostPath} is outside the project root and is not visible in the container.`,
    );
  return rel ? `${CONTAINER_ROOT}/${rel.split(sep).join('/')}` : CONTAINER_ROOT;
}

export function fromContainerPath(path: string, root: string): string {
  if (path === CONTAINER_ROOT) return resolve(root);
  if (!path.startsWith(`${CONTAINER_ROOT}/`)) return path;
  return join(
    resolve(root),
    ...path.slice(CONTAINER_ROOT.length + 1).split('/'),
  );
}

export function volumeName(root: string): string {
  const hash = createHash('sha256')
    .update(resolve(root).toLowerCase())
    .digest('hex')
    .slice(0, 12);
  return `tc-node-modules-${hash}`;
}

const INSTALLERS: Array<{ file: string; command: string }> = [
  {
    file: 'bun.lock',
    command: 'bun install --frozen-lockfile',
  },
  {
    file: 'bun.lockb',
    command: 'bun install --frozen-lockfile',
  },
  { file: 'package-lock.json', command: 'npm ci --no-audit --no-fund' },
  { file: 'npm-shrinkwrap.json', command: 'npm ci --no-audit --no-fund' },
  {
    file: 'pnpm-lock.yaml',
    command:
      'npm install -g pnpm --silent && pnpm install --frozen-lockfile --config.confirmModulesPurge=false',
  },
  {
    file: 'yarn.lock',
    command: 'npx --yes yarn@1 install --frozen-lockfile --non-interactive',
  },
];

function validateBunVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(
      `TC_E_CONFIG_INVALID: Bun requires an exact version, received ${version}.`,
    );
  return version;
}

const MANAGER_LOCKFILES = new Map([
  ['bun', ['bun.lock', 'bun.lockb']],
  ['npm', ['npm-shrinkwrap.json', 'package-lock.json']],
  ['pnpm', ['pnpm-lock.yaml']],
  ['yarn', ['yarn.lock']],
]);

export function getInstallPlan(
  root: string,
  image: string,
): { lockfile?: string; command: string; key: string } {
  const manifestSource = readFileSync(join(root, 'package.json'));
  const manifest = JSON.parse(manifestSource.toString()) as {
    packageManager?: string;
  };
  const available = INSTALLERS.filter((item) =>
    existsSync(join(root, item.file)),
  );
  const manager = manifest.packageManager?.split('@')[0];
  const installer =
    available.find((item) =>
      MANAGER_LOCKFILES.get(manager ?? '')?.includes(item.file),
    ) ?? available[0];
  if (manager === 'bun' && !installer?.file.startsWith('bun.lock'))
    throw new Error(
      'TC_E_CONFIG_INVALID: a Bun project requires bun.lock or bun.lockb for container installation.',
    );
  const bunVersion =
    manager === 'bun'
      ? validateBunVersion(manifest.packageManager?.slice(4) ?? '')
      : DEFAULT_BUN_VERSION;
  const command = installer?.file.startsWith('bun.lock')
    ? `npm install -g bun@${bunVersion} --no-audit --no-fund && bun install --frozen-lockfile`
    : (installer?.command ??
      'npm install --no-package-lock --no-audit --no-fund');
  const keySource = installer
    ? readFileSync(join(root, installer.file))
    : readFileSync(join(root, 'package.json'));
  const key = createHash('sha256')
    .update(image)
    .update('\0')
    .update(manifestSource)
    .update('\0')
    .update(command)
    .update('\0')
    .update(keySource)
    .digest('hex')
    .slice(0, 16);
  return {
    lockfile: installer?.file,
    command,
    key,
  };
}

export function installScript(
  plan: { command: string; key: string },
  bunVersion?: string,
): string {
  const marker = `${CONTAINER_ROOT}/node_modules/.test-container-install`;
  return [
    'set -e',
    `if [ "$(cat ${marker} 2>/dev/null)" != "${plan.key}" ]; then`,
    `  ${plan.command}`,
    `  echo ${plan.key} > ${marker}`,
    'fi',
    ...(bunVersion
      ? [
          // npm ci may remove the tool cache, so restore it after dependencies.
          `if [ ! -x ${CONTAINER_BUN} ] || [ "$(${CONTAINER_BUN} --version)" != "${validateBunVersion(bunVersion)}" ]; then`,
          `  npm install --prefix ${BUN_TOOLS} --no-save --package-lock=false --no-audit --no-fund bun@${bunVersion}`,
          'fi',
        ]
      : []),
  ].join('\n');
}

export function buildRunArgs(options: {
  settings: DockerSettings;
  image: string;
  root: string;
  toolDir: string;
  workdir: string;
  runId: string;
  name: string;
  envNames: string[];
  command: string[];
  owner?: { uid: number; gid: number };
}): string[] {
  const { settings } = options;
  const command = options.owner
    ? [
        'sh',
        '-c',
        `"$@"; code=$?; chown -R ${options.owner.uid}:${options.owner.gid} ${CONTAINER_ROOT}/.test-container 2>/dev/null; exit $code`,
        'sh',
        ...options.command,
      ]
    : options.command;
  return [
    'run',
    '--rm',
    '--init',
    '--name',
    options.name,
    '--label',
    `${RUN_LABEL}=${options.runId}`,
    '-v',
    `${resolve(options.root)}:${CONTAINER_ROOT}`,
    '-v',
    `${volumeName(options.root)}:${CONTAINER_ROOT}/node_modules`,
    '-v',
    `${resolve(options.toolDir)}:${CONTAINER_TOOL_DIR}:ro`,
    '-w',
    toContainerPath(options.workdir, options.root),
    ...(settings.hostGateway
      ? ['--add-host=host.docker.internal:host-gateway']
      : []),
    ...settings.extraArgs,
    ...[...new Set(options.envNames)].flatMap((name) => ['-e', name]),
    options.image,
    ...command,
  ];
}
