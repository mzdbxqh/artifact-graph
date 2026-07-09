import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { VERSION_LOCK_PATH } from './versioned-traceability.js';

// @scenario S-06 @feature ACA3
const execFileAsync = promisify(execFile);
const KNOWN_COMMANDS = [
  'init',
  'scan',
  'validate',
  'query',
  'context',
  'packet',
  'packet-prompt',
  'packet-audit',
  'packet-prompt-audit',
  'version-index',
  'version-lock audit',
  'version-lock update',
  'version-lock bootstrap',
  'version-lock refresh',
  'trace-version',
  'next-id',
  'render',
  'doctor',
];

export type ArtifactGraphCliSource = 'node_modules' | 'path' | 'legacy' | 'plugin-bundled';

export interface ArtifactGraphCliCandidate {
  source: ArtifactGraphCliSource;
  path: string;
  exists: boolean;
}

export interface ArtifactGraphCliResolution {
  path?: string;
  source?: ArtifactGraphCliSource;
  candidates: ArtifactGraphCliCandidate[];
  warnings: string[];
}

export interface ResolveArtifactGraphCliOptions {
  projectCliPath?: string;
  fallbackPath?: string;
}

export interface ArtifactChainDoctorReport {
  schemaVersion: '1.0';
  root: string;
  cli: ArtifactGraphCliResolution;
  node: {
    version: string;
    compatible: boolean;
    required: '>=22.0.0';
  };
  config: {
    path: string;
    exists: boolean;
  };
  lock: {
    path: string;
    exists: boolean;
  };
  supportedCommands: string[];
  warnings: string[];
}

export async function resolveArtifactGraphCli(root: string, options: ResolveArtifactGraphCliOptions = {}): Promise<ArtifactGraphCliResolution> {
  const pathCli = await findCommandOnPath('artifact-graph');
  const legacyCliPath = options.projectCliPath ?? process.env.ARTIFACT_GRAPH_LEGACY_CLI;
  const candidates: ArtifactGraphCliCandidate[] = [
    {
      source: 'node_modules',
      path: join(root, 'node_modules/.bin/artifact-graph'),
      exists: false,
    },
    {
      source: 'path',
      path: pathCli ?? 'artifact-graph',
      exists: pathCli !== undefined,
    },
    {
      source: 'legacy',
      path: legacyCliPath ? resolveCandidatePath(root, legacyCliPath) : 'ARTIFACT_GRAPH_LEGACY_CLI',
      exists: false,
    },
    {
      source: 'plugin-bundled',
      path: resolveCandidatePath(root, options.fallbackPath ?? 'dist/cli.js'),
      exists: false,
    },
  ];

  for (const candidate of candidates) {
    candidate.exists = await pathExists(candidate.path);
  }

  const selected = candidates.find((candidate) => candidate.exists);
  const warnings = selected ? [] : ['No artifact-graph CLI was found in node_modules, PATH, explicit legacy override, or plugin-bundled locations.'];
  return {
    path: selected?.path,
    source: selected?.source,
    candidates,
    warnings,
  };
}

export async function doctorArtifactChain(root: string, options: ResolveArtifactGraphCliOptions = {}): Promise<ArtifactChainDoctorReport> {
  const cli = await resolveArtifactGraphCli(root, options);
  const configPath = join(root, 'artifact-graph.config.yaml');
  const lockPath = join(root, VERSION_LOCK_PATH);
  const supportedCommands = cli.path ? await detectSupportedCommands(cli.path) : [];
  const nodeCompatible = isNodeCompatible(process.versions.node);
  const warnings = [
    ...cli.warnings,
    ...(nodeCompatible ? [] : [`Node.js ${process.versions.node} does not satisfy >=22.0.0.`]),
  ];

  return {
    schemaVersion: '1.0',
    root,
    cli,
    node: {
      version: process.versions.node,
      compatible: nodeCompatible,
      required: '>=22.0.0',
    },
    config: {
      path: configPath,
      exists: await pathExists(configPath),
    },
    lock: {
      path: lockPath,
      exists: await pathExists(lockPath),
    },
    supportedCommands,
    warnings,
  };
}

export function renderDoctorMarkdown(report: ArtifactChainDoctorReport): string {
  const lines = [
    '# Artifact Chain Doctor',
    '',
    `Root: \`${report.root}\``,
    `CLI: ${report.cli.path ? `\`${report.cli.path}\` (${report.cli.source})` : 'not found'}`,
    `Node: ${report.node.version} (${report.node.compatible ? 'compatible' : 'incompatible'}, required ${report.node.required})`,
    `Config: \`${report.config.path}\` ${report.config.exists ? 'found' : 'missing'}`,
    `Lock: \`${report.lock.path}\` ${report.lock.exists ? 'found' : 'missing'}`,
    '',
  ];
  if (report.supportedCommands.length > 0) {
    lines.push('## Supported Commands');
    for (const command of report.supportedCommands) {
      lines.push(`- \`${command}\``);
    }
    lines.push('');
  }
  if (report.warnings.length > 0) {
    lines.push('## Warnings');
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function detectSupportedCommands(cliPath: string): Promise<string[]> {
  const command = cliPath.endsWith('.js') ? process.execPath : cliPath;
  const args = cliPath.endsWith('.js') ? [cliPath, '--help'] : ['--help'];
  let help = '';
  try {
    const result = await execFileAsync(command, args);
    help = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    const maybe = error as Error & { stdout?: string; stderr?: string };
    help = `${maybe.stdout ?? ''}\n${maybe.stderr ?? ''}`;
  }
  return KNOWN_COMMANDS.filter((commandName) => help.includes(commandName));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function findCommandOnPath(command: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync('sh', ['-c', `command -v ${command}`]);
    const resolved = result.stdout.trim().split('\n')[0];
    return resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function resolveCandidatePath(root: string, candidatePath: string): string {
  return isAbsolute(candidatePath) ? candidatePath : resolve(root, candidatePath);
}

function isNodeCompatible(version: string): boolean {
  const major = Number(version.split('.')[0]);
  return Number.isFinite(major) && major >= 22;
}
