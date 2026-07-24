#!/usr/bin/env node
import yaml from 'js-yaml';
import { realpathSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assemblePacket,
  computeE2eCoverageStats,
  DEFAULT_SCHEMA,
  formatContextMarkdown,
  generateE2eRegistry,
  loadConfig,
  nextId,
  queryGraph,
  renderMermaid,
  renderPacketMarkdown,
  resolveArtifactContext,
  scanArtifacts,
  validateExecutableTraceability,
  validateGraph,
  validateScenarioPrdLinkIndex,
  writeGraphCache,
  getTargetArtifactTypes,
} from './index.js';
import {
  CONTRACT_ERROR_CODES,
  loadContract,
  loadContractCatalog,
  validateContractAgainstSchema,
  validateRelations,
  validatePolicyCompatibility,
  computeRevisionDigest,
  ContractError,
} from './contract-kernel.js';
import type { ProjectPolicy, ContractDefinition } from './contract-kernel.js';
import { resolveCliTarget } from './target-selector.js';
import { auditPackets, discoverAndAuditPackets, parseTargetsFile } from './packet-audit.js';
import { validatePacket, validatePacketMarkdown } from './packet-validator.js';
import { renderPacketPrompt, DEFAULT_MAX_CHARS, MIN_PROMPT_CHARS } from './packet-prompt.js';
import { validatePacketPrompt } from './packet-prompt-validator.js';
import { auditPromptBatch, discoverAndAuditPromptBatch } from './packet-prompt-audit.js';
import { doctorArtifactChain, renderDoctorMarkdown } from './cli-resolver.js';
import { validateReviewResult } from './review-result-validator.js';
import { collectChangedPaths } from './git-changes.js';
import { resolveGitHookPath } from './git-hook-path.js';
import { applyPreparedManagedHookBlocks, prepareManagedHookBlock } from './hook-installer.js';
import {
  VERSION_LOCK_PATH,
  auditVersionLock,
  bootstrapVersionLock,
  buildVersionIndex,
  refreshVersionLock,
  renderTraceVersionMarkdown,
  renderVersionLockAuditMarkdown,
  renderVersionLockRefreshMarkdown,
  traceVersion,
  updateVersionLock,
} from './versioned-traceability.js';
import type { PacketPromptError } from './packet-prompt.js';
import type { ImplementationPacket } from './packet-assembler.js';

export interface CliIo {
  cwd?: string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
}

interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const parsed = parseArgs(argv);
  const cwd = io.cwd ?? process.cwd();
  const out = io.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const err = io.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const root = String(parsed.flags.root ?? cwd);

  try {
    // Unified help interception: check for --help/-h before any command side effects
    const hasHelpFlag = parsed.flags.help === true
      || parsed.positional.some((p) => p === '--help' || p === '-h');
    if (parsed.command === '--help' || parsed.command === '-h' || parsed.command === 'help' || hasHelpFlag) {
      out(helpText());
      return 0;
    }
    switch (parsed.command) {
      case 'init': {
        await initConfig(root);
        out(`Created ${join(root, 'artifact-graph.config.yaml')}\n`);
        return 0;
      }
      case 'scan': {
        const graph = await scanArtifacts(root);
        await writeGraphCache(root, graph);
        out(`Scanned ${graph.nodes.length} artifacts and ${graph.edges.length} relations\n`);
        return 0;
      }
      case 'validate': {
        const includes = new Set(
          typeof parsed.flags.include === 'string'
            ? parsed.flags.include.split(',')
            : []
        );
        const config = await loadConfig(root);
        const graph = await scanArtifacts(root, config);
        const issues = validateGraph(graph, config);
        issues.push(...await validateScenarioPrdLinkIndex(root, graph));
        issues.push(...await validateExecutableTraceability(root, config));

        // O2: E2E coverage stats
        const includeCoverage = includes.has('e2e-coverage')
          || config.e2e?.executable_ref_warning !== undefined
          || config.e2e?.executable_ref_error !== undefined;
        let coverageStats = null;
        if (includeCoverage) {
          const e2eConfig = config.e2e ?? {};
          coverageStats = await computeE2eCoverageStats(graph, root, {
            executableRefWarning: e2eConfig.executable_ref_warning,
            executableRefError: e2eConfig.executable_ref_error,
            reportUncoveredScenarios: e2eConfig.report_uncovered_scenarios,
            reportUncoveredFeatures: e2eConfig.report_uncovered_features,
            scenarioWaivers: e2eConfig.scenario_waivers,
            featureWaivers: e2eConfig.feature_waivers,
          });
          // Convert threshold warnings/errors to validation issues
          for (const msg of coverageStats.thresholdWarnings) {
            issues.push({
              code: 'E2E_COVERAGE_WARNING',
              severity: 'warning',
              message: msg,
              path: 'e2e-coverage',
              line: 1,
            });
          }
          for (const msg of coverageStats.thresholdErrors) {
            issues.push({
              code: 'E2E_COVERAGE_ERROR',
              severity: 'error',
              message: msg,
              path: 'e2e-coverage',
              line: 1,
            });
          }
        }

        if (parsed.flags.format === 'json') {
          if (coverageStats) {
            const output: Record<string, unknown> = {
              issues,
              e2eCoverage: {
                totalTestCases: coverageStats.totalTestCases,
                withExecutableRef: coverageStats.withExecutableRef,
                executableRefRate: coverageStats.executableRefRate,
                statusBreakdown: coverageStats.statusBreakdown,
                chainTypeBreakdown: coverageStats.chainTypeBreakdown,
                uncoveredScenarios: coverageStats.uncoveredScenarios,
                uncoveredFeatures: coverageStats.uncoveredFeatures,
                acCoverageRateByFeature: coverageStats.acCoverageRateByFeature,
                scenarioCoverage: coverageStats.scenarioCoverage,
                featureCoverage: coverageStats.featureCoverage,
              },
            };
            out(`${JSON.stringify(output, null, 2)}\n`);
          } else {
            out(`${JSON.stringify(issues, null, 2)}\n`);
          }
        } else {
          if (coverageStats) {
            out(`E2E Coverage: ${coverageStats.executableRefRate} executable_ref\n`);
            out(`  Status: ${JSON.stringify(coverageStats.statusBreakdown)}\n`);
            out(`  Chain types: ${JSON.stringify(coverageStats.chainTypeBreakdown)}\n`);
            if (coverageStats.uncoveredScenarios.length > 0) {
              out(`  Uncovered scenarios (${coverageStats.uncoveredScenarios.length}): ${coverageStats.uncoveredScenarios.join(', ')}\n`);
            }
            if (coverageStats.uncoveredFeatures.length > 0) {
              out(`  Uncovered features (${coverageStats.uncoveredFeatures.length}): ${coverageStats.uncoveredFeatures.join(', ')}\n`);
            }
            if (Object.keys(coverageStats.acCoverageRateByFeature).length > 0) {
              out(`  AC coverage by feature:\n`);
              for (const [feature, rate] of Object.entries(coverageStats.acCoverageRateByFeature)) {
                out(`    ${feature}: ${rate.numerator}/${rate.denominator} (${(rate.rate * 100).toFixed(1)}%)\n`);
              }
            }
            // Multi-dimensional coverage summary
            const scenarioStats = Object.values(coverageStats.scenarioCoverage);
            const featureStats = Object.values(coverageStats.featureCoverage);
            if (scenarioStats.length > 0) {
              const linked = scenarioStats.filter((s) => s.linked).length;
              const acCovered = scenarioStats.filter((s) => s.acCovered).length;
              const waived = scenarioStats.filter((s) => s.waived).length;
              const verified = scenarioStats.filter((s) => s.verified).length;
              out(`  Scenario coverage: linked=${linked}, acCovered=${acCovered}, waived=${waived}, verified=${verified}\n`);
            }
            if (featureStats.length > 0) {
              const linked = featureStats.filter((s) => s.linked).length;
              const acCovered = featureStats.filter((s) => s.acCovered).length;
              const waived = featureStats.filter((s) => s.waived).length;
              const verified = featureStats.filter((s) => s.verified).length;
              out(`  Feature coverage: linked=${linked}, acCovered=${acCovered}, waived=${waived}, verified=${verified}\n`);
            }
          }
          if (issues.length === 0) {
            out('No validation issues\n');
          } else {
            out(issues.map((issue) => `${issue.code} ${issue.path}:${issue.line} ${issue.message}`).join('\n') + '\n');
          }
        }
        return issues.some((issue) => issue.severity === 'error') && !parsed.flags['warning-only'] ? 1 : 0;
      }
      case 'query': {
        const graph = await scanArtifacts(root);
        const result = queryGraph(graph, {
          from: typeof parsed.flags.from === 'string' ? parsed.flags.from : undefined,
          to: typeof parsed.flags.to === 'string' ? parsed.flags.to : undefined,
          depth: typeof parsed.flags.depth === 'string' ? Number(parsed.flags.depth) : undefined,
        });
        if (parsed.flags.format === 'json') {
          out(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          out(result.nodes.map((node) => `${node.uid} ${node.path}:${node.line}`).join('\n') + '\n');
        }
        return 0;
      }
      case 'render': {
        const graph = await scanArtifacts(root);
        const view = typeof parsed.flags.from === 'string' || typeof parsed.flags.to === 'string'
          ? queryGraph(graph, {
              from: typeof parsed.flags.from === 'string' ? parsed.flags.from : undefined,
              to: typeof parsed.flags.to === 'string' ? parsed.flags.to : undefined,
            })
          : graph;
        if (parsed.flags.format && parsed.flags.format !== 'mermaid') {
          throw new Error(`Unsupported render format ${String(parsed.flags.format)}`);
        }
        out(renderMermaid(view));
        return 0;
      }
      case 'next-id': {
        const type = parsed.positional[0];
        const range = parsed.flags.range;
        if (!type || typeof range !== 'string') {
          throw new Error('Usage: artifact-graph next-id <type> --range <name>');
        }
        const config = await loadConfig(root);
        const graph = await scanArtifacts(root, config);
        out(`${nextId(graph, config, type, range)}\n`);
        return 0;
      }
      case 'context': {
        const config = await loadConfig(root);
        let resolvedTarget;
        try {
          resolvedTarget = resolveCliTarget(parsed.flags, config);
        } catch (e) {
          err(`${(e as Error).message}\n`);
          err('Usage: artifact-graph context (--target <type>:<id> | --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id>) [--mode full|implementation] [--max-per-category <n>] [--format json]\n');
          return 1;
        }
        const contextMode = typeof parsed.flags.mode === 'string' ? parsed.flags.mode as 'full' | 'implementation' : 'implementation';
        if (contextMode !== 'implementation' && contextMode !== 'full') {
          err(`Invalid --mode: "${parsed.flags.mode}". Allowed values: implementation, full\n`);
          return 1;
        }
        const maxPerCategory = typeof parsed.flags['max-per-category'] === 'string' ? Number(parsed.flags['max-per-category']) : undefined;
        if (typeof parsed.flags['max-per-category'] === 'string') {
          const raw = parsed.flags['max-per-category'];
          const num = Number(raw);
          if (!Number.isFinite(num) || num < 1 || !Number.isInteger(num)) {
            err(`Invalid --max-per-category: "${raw}". Must be a positive integer\n`);
            return 1;
          }
        }
        const graph = await scanArtifacts(root);
        const manifest = resolveArtifactContext(graph, {
          target: resolvedTarget,
          mode: contextMode,
          maxPerCategory,
          universalBaseline: config.context?.universal_baseline,
          root,
        });
        if (parsed.flags.format === 'json') {
          out(`${JSON.stringify(manifest, null, 2)}\n`);
        } else {
          out(formatContextMarkdown(manifest));
        }
        return manifest.missing.length > 0 ? 1 : 0;
      }
      case 'packet': {
        const config = await loadConfig(root);
        let resolvedTarget;
        try {
          resolvedTarget = resolveCliTarget(parsed.flags, config);
        } catch (e) {
          err(`${(e as Error).message}\n`);
          err('Usage: artifact-graph packet (--target <type>:<id> | --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id>) [--mode full|implementation] [--max-per-category <n>] [--format json|markdown] [--out <path>] [--no-validate]\n');
          return 1;
        }
        const packetMode = typeof parsed.flags.mode === 'string' ? parsed.flags.mode as 'full' | 'implementation' : 'implementation';
        if (packetMode !== 'implementation' && packetMode !== 'full') {
          err(`Invalid --mode: "${parsed.flags.mode}". Allowed values: implementation, full\n`);
          return 1;
        }
        const packetMaxPerCategory = typeof parsed.flags['max-per-category'] === 'string' ? Number(parsed.flags['max-per-category']) : undefined;
        if (typeof parsed.flags['max-per-category'] === 'string') {
          const raw2 = parsed.flags['max-per-category'];
          const num2 = Number(raw2);
          if (!Number.isFinite(num2) || num2 < 1 || !Number.isInteger(num2)) {
            err(`Invalid --max-per-category: "${raw2}". Must be a positive integer\n`);
            return 1;
          }
        }
        const graph = await scanArtifacts(root);
        const manifest = resolveArtifactContext(graph, {
          target: resolvedTarget,
          mode: packetMode,
          maxPerCategory: packetMaxPerCategory,
          universalBaseline: config.context?.universal_baseline,
          root,
        });
        if (manifest.missing.length > 0) {
          err('Missing artifacts detected — cannot generate packet:\n');
          for (const m of manifest.missing) {
            err(`  - ${m}\n`);
          }
          err('\nFix the traceability gaps above before generating an implementation packet.\n');
          if (typeof parsed.flags.out === 'string') {
            // Write error report to out path so automation can inspect it
            const errorReport = JSON.stringify({ error: 'missing', missing: manifest.missing }, null, 2);
            await writeFile(parsed.flags.out, errorReport + '\n');
          }
          return 1;
        }
        const packet = assemblePacket(manifest, {
          mode: packetMode,
          maxPerCategory: packetMaxPerCategory,
        });

        // Validate packet unless --no-validate is set
        const skipValidate = parsed.flags['no-validate'] === true;
        if (!skipValidate) {
          const vResult = validatePacket(packet, config);
          if (vResult.issues.length > 0) {
            for (const issue of vResult.issues) {
              err(`[${issue.severity.toUpperCase()}] ${issue.code}: ${issue.message}\n`);
            }
          }
          if (!vResult.ok) {
            err('Packet validation failed. Use --no-validate to skip.\n');
            return 1;
          }
        }

        const packetFormat = typeof parsed.flags.format === 'string' ? parsed.flags.format : 'markdown';
        let output: string;
        if (packetFormat === 'json') {
          output = JSON.stringify(packet, null, 2) + '\n';
        } else if (packetFormat === 'markdown') {
          output = renderPacketMarkdown(packet);
        } else {
          err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown\n`);
          return 1;
        }
        if (typeof parsed.flags.out === 'string') {
          await writeFile(parsed.flags.out, output);
          out(`Packet written to ${parsed.flags.out}\n`);
        } else {
          out(output);
        }
        return 0;
      }
      case 'packet-prompt': {
        // --format validation (Phase 3): only 'markdown' is allowed
        const promptFormat = typeof parsed.flags.format === 'string' ? parsed.flags.format : undefined;
        if (promptFormat && promptFormat !== 'markdown') {
          err(`不支持的 --format: "${promptFormat}". packet-prompt 仅支持 --format markdown\n`);
          return 1;
        }

        // --packet JSON input (Phase 2)
        const packetJsonPath = typeof parsed.flags.packet === 'string' ? parsed.flags.packet : undefined;

        // --packet is mutually exclusive with --target/--feature/--scenario/--decision
        const hasAnyTarget = typeof parsed.flags.target === 'string'
          || typeof parsed.flags.feature === 'string'
          || typeof parsed.flags.scenario === 'string'
          || typeof parsed.flags.decision === 'string'
          || typeof parsed.flags.design === 'string'
          || typeof parsed.flags['e2e-test'] === 'string';
        if (packetJsonPath && hasAnyTarget) {
          err('错误：--packet 与 --target/--feature/--scenario/--decision/--design/--e2e-test 互斥，只能指定一种输入方式\n');
          return 1;
        }

        // Must have either --packet or exactly one target
        if (!packetJsonPath && !hasAnyTarget) {
          err('Usage: artifact-graph packet-prompt (--target <type>:<id> | --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id> | --packet <path>) [--max-chars <n>] [--format markdown] [--out <path>]\n');
          return 1;
        }

        const maxChars = typeof parsed.flags['max-chars'] === 'string' ? Number(parsed.flags['max-chars']) : DEFAULT_MAX_CHARS;
        if (typeof parsed.flags['max-chars'] === 'string') {
          const rawMc = parsed.flags['max-chars'];
          const numMc = Number(rawMc);
          if (!Number.isFinite(numMc) || numMc < MIN_PROMPT_CHARS || !Number.isInteger(numMc)) {
            err(`Invalid --max-chars: "${rawMc}". Must be an integer >= ${MIN_PROMPT_CHARS}\n`);
            return 1;
          }
        }

        let promptPacket: ImplementationPacket;

        if (packetJsonPath) {
          // Read and validate packet JSON
          let rawJson: string;
          try {
            rawJson = await readFile(packetJsonPath, 'utf-8');
          } catch (readErr) {
            err(`错误：无法读取 packet 文件: "${packetJsonPath}" — ${(readErr as Error).message}\n`);
            return 1;
          }
          let parsedPacket: unknown;
          try {
            parsedPacket = JSON.parse(rawJson);
          } catch {
            err(`错误：packet 文件不是有效的 JSON: "${packetJsonPath}"\n`);
            return 1;
          }
          // Validate ImplementationPacket schema
          const pp = parsedPacket as Record<string, unknown>;
          const missingFields: string[] = [];
          if (pp.schemaVersion !== '1.0') missingFields.push('schemaVersion (需要 "1.0")');
          if (!pp.target || typeof pp.target !== 'object') missingFields.push('target');
          if (!pp.requiredBaseline || typeof pp.requiredBaseline !== 'object') missingFields.push('requiredBaseline');
          if (!pp.contextByTier || typeof pp.contextByTier !== 'object') missingFields.push('contextByTier');
          if (!Array.isArray(pp.validationCommands)) missingFields.push('validationCommands');
          if (!pp.implementationBlueprintDraft || typeof pp.implementationBlueprintDraft !== 'object') missingFields.push('implementationBlueprintDraft');
          if (missingFields.length > 0) {
            err(`错误：packet JSON 缺失或无效字段:\n`);
            for (const f of missingFields) {
              err(`  - ${f}\n`);
            }
            return 1;
          }
          promptPacket = parsedPacket as ImplementationPacket;
        } else {
          // Scan artifacts for target
          const config = await loadConfig(root);
          let resolvedTarget;
          try {
            resolvedTarget = resolveCliTarget(parsed.flags, config);
          } catch (e) {
            err(`${(e as Error).message}\n`);
            return 1;
          }
          const graph = await scanArtifacts(root);
          const promptManifest = resolveArtifactContext(graph, {
            target: resolvedTarget,
            mode: 'implementation',
            universalBaseline: config.context?.universal_baseline,
            root,
          });
          if (promptManifest.missing.length > 0) {
            err('Missing artifacts detected — cannot generate prompt:\n');
            for (const m of promptManifest.missing) {
              err(`  - ${m}\n`);
            }
            return 1;
          }
          promptPacket = assemblePacket(promptManifest, {
            mode: 'implementation',
            generatedAt: typeof parsed.flags['generated-at'] === 'string' ? parsed.flags['generated-at'] : undefined,
          });
        }

        const promptResult = renderPacketPrompt(promptPacket, {
          maxChars,
          generatedAt: typeof parsed.flags['generated-at'] === 'string' ? parsed.flags['generated-at'] : undefined,
          root,
        });
        // Handle structured error from renderPacketPrompt
        if (typeof promptResult === 'object' && 'ok' in promptResult && !promptResult.ok) {
          const e = promptResult as PacketPromptError;
          err(`错误：${e.reason}。实际长度 ${e.actualLength}，最小需要 ${e.minRequired} 字符。\n`);
          return 1;
        }
        const prompt = promptResult as string;
        const promptValidation = validatePacketPrompt(prompt);
        const promptErrors = promptValidation.issues.filter((issue) => issue.severity === 'error');
        if (promptErrors.length > 0) {
          err('错误：生成的 packet-prompt 未通过质量校验：\n');
          for (const issue of promptErrors) {
            err(`  - ${issue.code}: ${issue.message}\n`);
          }
          return 1;
        }
        const promptWarnings = promptValidation.issues.filter((issue) => issue.severity === 'warning');
        for (const issue of promptWarnings) {
          err(`警告：${issue.code}: ${issue.message}\n`);
        }
        if (typeof parsed.flags.out === 'string') {
          await writeFile(parsed.flags.out, prompt);
          out(`Prompt written to ${parsed.flags.out}\n`);
        } else {
          out(prompt);
        }
        return 0;
      }
      case 'packet-audit': {
        const targetsFile = typeof parsed.flags['targets-file'] === 'string' ? parsed.flags['targets-file'] : undefined;
        const discover = parsed.flags.discover === true;
        if (targetsFile && discover) {
          err('Error: --discover and --targets-file are mutually exclusive\n');
          return 1;
        }
        if (!targetsFile && !discover) {
          err('Usage: artifact-graph packet-audit (--targets-file <path> | --discover) [--out-dir <path>] [--limit <n>] [--format json|markdown] [--mode full|implementation] [--max-per-category <n>] [--summary-only] [--sample-targets <csv>] [--summary-detail full|compact]\n');
          return 1;
        }
        const summaryOnly = parsed.flags['summary-only'] === true;
        const sampleTargetsRaw = typeof parsed.flags['sample-targets'] === 'string' ? parsed.flags['sample-targets'] : undefined;
        if (summaryOnly && sampleTargetsRaw) {
          err('Error: --summary-only and --sample-targets are mutually exclusive\n');
          return 1;
        }
        let sampleTargets: string[] | undefined;
        if (sampleTargetsRaw) {
          sampleTargets = sampleTargetsRaw.split(',').map((s) => s.trim()).filter(Boolean);
          const auditConfig = await loadConfig(root);
          const validTargetTypes = getTargetArtifactTypes(auditConfig);
          for (const st of sampleTargets) {
            const colonIdx = st.indexOf(':');
            if (colonIdx < 0) {
              err(`Invalid --sample-targets entry: "${st}". Expected format "type:id"\n`);
              return 1;
            }
            const stType = st.slice(0, colonIdx).trim();
            if (!validTargetTypes.includes(stType)) {
              err(`Invalid --sample-targets entry: "${st}". Type must be one of: ${validTargetTypes.join(', ')}\n`);
              return 1;
            }
            const stId = st.slice(colonIdx + 1).trim();
            if (!stId) {
              err(`Invalid --sample-targets entry: "${st}". ID is empty\n`);
              return 1;
            }
          }
        }
        const auditOutDir = typeof parsed.flags['out-dir'] === 'string' ? parsed.flags['out-dir'] : undefined;
        if (!auditOutDir && !summaryOnly) {
          err('Usage: artifact-graph packet-audit (--targets-file <path> | --discover) [--out-dir <path>] [--limit <n>] [--format json|markdown] [--mode full|implementation] [--max-per-category <n>] [--summary-only] [--sample-targets <csv>] [--summary-detail full|compact]\n');
          err('  --out-dir is required unless --summary-only is set\n');
          return 1;
        }
        const auditFormat = typeof parsed.flags.format === 'string' ? parsed.flags.format as 'json' | 'markdown' : 'markdown';
        if (auditFormat !== 'json' && auditFormat !== 'markdown') {
          err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown\n`);
          return 1;
        }
        const auditMode = typeof parsed.flags.mode === 'string' ? parsed.flags.mode as 'full' | 'implementation' : 'implementation';
        if (auditMode !== 'implementation' && auditMode !== 'full') {
          err(`Invalid --mode: "${parsed.flags.mode}". Allowed values: implementation, full\n`);
          return 1;
        }
        const auditMaxPerCategory = typeof parsed.flags['max-per-category'] === 'string' ? Number(parsed.flags['max-per-category']) : undefined;
        if (typeof parsed.flags['max-per-category'] === 'string') {
          const raw3 = parsed.flags['max-per-category'];
          const num3 = Number(raw3);
          if (!Number.isFinite(num3) || num3 < 1 || !Number.isInteger(num3)) {
            err(`Invalid --max-per-category: "${raw3}". Must be a positive integer\n`);
            return 1;
          }
        }
        const limit = typeof parsed.flags.limit === 'string' ? Number(parsed.flags.limit) : undefined;
        if (typeof parsed.flags.limit === 'string') {
          const rawLimit = parsed.flags.limit;
          const numLimit = Number(rawLimit);
          // limit=0 means "no limit" (discover all)
          if (!Number.isFinite(numLimit) || numLimit < 0 || !Number.isInteger(numLimit)) {
            err(`Invalid --limit: "${rawLimit}". Must be a non-negative integer (0 = no limit)\n`);
            return 1;
          }
        }
        const summaryDetail = typeof parsed.flags['summary-detail'] === 'string' ? parsed.flags['summary-detail'] as 'full' | 'compact' : undefined;
        if (summaryDetail && summaryDetail !== 'full' && summaryDetail !== 'compact') {
          err(`Invalid --summary-detail: "${parsed.flags['summary-detail']}". Allowed values: full, compact\n`);
          return 1;
        }

        let summary;
        if (discover) {
          const discoverConfig = await loadConfig(root);
          summary = await discoverAndAuditPackets(root, {
            root,
            outDir: auditOutDir,
            format: auditFormat,
            mode: auditMode,
            maxPerCategory: auditMaxPerCategory,
            limit: limit === 0 ? Infinity : limit,
            summaryOnly,
            sampleTargets,
            summaryDetail,
            universalBaseline: discoverConfig.context?.universal_baseline,
          });
        } else {
          const targetsContent = await readFile(targetsFile!, 'utf-8');
          const auditConfig2 = await loadConfig(root);
          const parseResult = parseTargetsFile(targetsContent, auditConfig2);
          if (parseResult.errors.length > 0) {
            for (const e of parseResult.errors) {
              err(`Parse error (line ${e.line}): ${e.message} — ${e.raw}\n`);
            }
            return 1;
          }
          if (parseResult.targets.length === 0) {
            err(`No valid targets found in ${targetsFile}\n`);
            return 1;
          }
          summary = await auditPackets(root, parseResult.targets, {
            root,
            outDir: auditOutDir,
            format: auditFormat,
            mode: auditMode,
            maxPerCategory: auditMaxPerCategory,
            sourceTargetsPath: targetsFile,
            summaryOnly,
            sampleTargets,
            summaryDetail,
            schema: auditConfig2,
            universalBaseline: auditConfig2.context?.universal_baseline,
          });
        }
        if (parsed.flags.format === 'json') {
          out(`${JSON.stringify(summary, null, 2)}\n`);
        } else {
          out(`Packet Audit Summary\n`);
          out(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed} | Missing: ${summary.missing}\n`);
          for (const t of summary.targets) {
            const statusIcon = t.status === 'passed' ? 'PASS' : t.status === 'failed' ? 'FAIL' : 'MISS';
            out(`  [${statusIcon}] ${t.type}:${t.id} items=${t.itemsCount} baseline=${t.baselineCount} missing=${t.missingCount} omitted=${t.omittedCount}`);
            if (t.outputPath) out(` -> ${t.outputPath}`);
            out('\n');
            for (const err2 of t.errors) {
              out(`        ${err2}\n`);
            }
          }
        }
        // discover 模式 total=0 说明 root 缺少 artifact 配置或制品，视为失败
        if (discover && summary.total === 0) {
          err(`Error: discover mode found 0 targets in ${root}. Is this a valid artifact root?\n`);
          return 1;
        }
        return summary.failed > 0 ? 1 : 0;
      }
      case 'packet-prompt-audit': {
        const ppaTargetsFile = typeof parsed.flags['targets-file'] === 'string' ? parsed.flags['targets-file'] : undefined;
        const ppaDiscover = parsed.flags.discover === true;
        if (ppaTargetsFile && ppaDiscover) {
          err('错误：--discover 与 --targets-file 互斥，只能选择一种方式\n');
          return 1;
        }
        if (!ppaTargetsFile && !ppaDiscover) {
          err('Usage: artifact-graph packet-prompt-audit (--targets-file <path> | --discover) [--out-dir <path>] [--format json|markdown] [--max-chars <n>] [--limit <n>] [--summary-only] [--summary-detail full|compact]\n');
          return 1;
        }
        // Reject --packet flag (audit only accepts targets-file or discover)
        if (parsed.flags.packet) {
          err('错误：packet-prompt-audit 不支持 --packet，仅接受 --targets-file 或 --discover\n');
          return 1;
        }
        const ppaFormat = typeof parsed.flags.format === 'string' ? parsed.flags.format as 'json' | 'markdown' : 'json';
        if (ppaFormat !== 'json' && ppaFormat !== 'markdown') {
          err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown\n`);
          return 1;
        }
        const ppaMaxChars = typeof parsed.flags['max-chars'] === 'string' ? Number(parsed.flags['max-chars']) : DEFAULT_MAX_CHARS;
        if (typeof parsed.flags['max-chars'] === 'string') {
          const rawPpa = parsed.flags['max-chars'];
          const numPpa = Number(rawPpa);
          if (!Number.isFinite(numPpa) || numPpa < MIN_PROMPT_CHARS || !Number.isInteger(numPpa)) {
            err(`Invalid --max-chars: "${rawPpa}". Must be an integer >= ${MIN_PROMPT_CHARS}\n`);
            return 1;
          }
        }
        const ppaOutDir = typeof parsed.flags['out-dir'] === 'string' ? parsed.flags['out-dir'] : undefined;
        const ppaSummaryOnly = parsed.flags['summary-only'] === true;
        const ppaSummaryDetail = typeof parsed.flags['summary-detail'] === 'string' ? parsed.flags['summary-detail'] as 'full' | 'compact' : undefined;
        if (ppaSummaryDetail && ppaSummaryDetail !== 'full' && ppaSummaryDetail !== 'compact') {
          err(`Invalid --summary-detail: "${parsed.flags['summary-detail']}". Allowed values: full, compact\n`);
          return 1;
        }
        // --limit for discover mode
        const ppaLimit = typeof parsed.flags.limit === 'string' ? Number(parsed.flags.limit) : undefined;
        if (typeof parsed.flags.limit === 'string') {
          const rawPpaLimit = parsed.flags.limit;
          const numPpaLimit = Number(rawPpaLimit);
          if (!Number.isFinite(numPpaLimit) || numPpaLimit < 0 || !Number.isInteger(numPpaLimit)) {
            err(`Invalid --limit: "${rawPpaLimit}". Must be a non-negative integer (0 = no limit)\n`);
            return 1;
          }
        }

        let ppaSummary;
        if (ppaDiscover) {
          // Discover mode: scan artifacts, discover targets, audit prompts
          const ppaDiscoverConfig = await loadConfig(root);
          ppaSummary = await discoverAndAuditPromptBatch(root, {
            root,
            outDir: ppaOutDir,
            format: ppaFormat,
            maxChars: ppaMaxChars,
            limit: ppaLimit === 0 ? Infinity : ppaLimit,
            summaryOnly: ppaSummaryOnly,
            summaryDetail: ppaSummaryDetail,
            universalBaseline: ppaDiscoverConfig.context?.universal_baseline,
          });
          // discover 模式 total=0 说明 root 缺少 artifact 配置或制品，视为失败
          if (ppaSummary.total === 0) {
            err(`错误：discover 模式在 ${root} 中未找到任何 target。请确认这是一个有效的 artifact root。\n`);
            return 1;
          }
        } else {
          // Targets-file mode
          // Read and parse targets file
          let ppaTargetsContent: string;
          try {
            ppaTargetsContent = await readFile(ppaTargetsFile!, 'utf-8');
          } catch (readErr) {
            err(`错误：无法读取 targets 文件: "${ppaTargetsFile}" — ${(readErr as Error).message}\n`);
            return 1;
          }
          if (ppaTargetsContent.trim().length === 0) {
            err(`错误：targets 文件为空: "${ppaTargetsFile}"\n`);
            return 1;
          }
          const ppaConfig = await loadConfig(root);
          const ppaParseResult = parseTargetsFile(ppaTargetsContent, ppaConfig);
          if (ppaParseResult.errors.length > 0) {
            for (const e of ppaParseResult.errors) {
              err(`Parse error (line ${e.line}): ${e.message} — ${e.raw}\n`);
            }
            return 1;
          }
          if (ppaParseResult.targets.length === 0) {
            err(`No valid targets found in ${ppaTargetsFile}\n`);
            return 1;
          }

          ppaSummary = await auditPromptBatch(root, ppaParseResult.targets, {
            root,
            outDir: ppaOutDir,
            format: ppaFormat,
            maxChars: ppaMaxChars,
            sourceTargetsPath: ppaTargetsFile,
            summaryOnly: ppaSummaryOnly,
            summaryDetail: ppaSummaryDetail,
            universalBaseline: ppaConfig.context?.universal_baseline,
          });
        }

        if (ppaFormat === 'json') {
          out(`${JSON.stringify(ppaSummary, null, 2)}\n`);
        } else {
          out(`Packet Prompt Audit Summary\n`);
          out(`总计: ${ppaSummary.total} | 通过: ${ppaSummary.passed} | 失败: ${ppaSummary.failed} | 警告: ${ppaSummary.warnings}\n`);
          if (ppaSummary.totalOmitted !== undefined && ppaSummary.totalOmitted > 0) {
            out(`（compact 模式：已省略 ${ppaSummary.totalOmitted} 个通过的 target 详情）\n`);
          }
          if (ppaSummary.countsByType) {
            const cbt = ppaSummary.countsByType;
            const typeEntries = Object.entries(cbt).map(([t, c]) => `${t}=${c.total}/${c.passed}`);
            out(`按类型: ${typeEntries.join(' ')}\n`);
          }
          for (const t of ppaSummary.targets) {
            const icon = t.ok ? 'PASS' : 'FAIL';
            out(`  [${icon}] ${t.type}:${t.id} length=${t.length}`);
            if (t.outputPath) out(` -> ${t.outputPath}`);
            out('\n');
            for (const issue of t.issues) {
              const sev = issue.severity === 'error' ? 'ERROR' : 'WARN';
              out(`        [${sev}] ${issue.code}: ${issue.message}\n`);
            }
          }
        }
        return ppaSummary.failed > 0 ? 1 : 0;
      }
      case 'version-index': {
        const format = typeof parsed.flags.format === 'string' ? parsed.flags.format : 'json';
        if (format !== 'json') {
          err(`Invalid --format: "${parsed.flags.format}". Allowed values: json\n`);
          return 1;
        }
        const index = await buildVersionIndex(root);
        const output = `${JSON.stringify(index, null, 2)}\n`;
        if (typeof parsed.flags.out === 'string') {
          await writeFile(parsed.flags.out, output);
          out(`Version index written to ${parsed.flags.out}\n`);
        } else {
          out(output);
        }
        return 0;
      }
      case 'version-lock': {
        const action = parsed.positional[0];
        const lockPath = typeof parsed.flags['lock-path'] === 'string' ? parsed.flags['lock-path'] : VERSION_LOCK_PATH;
        if (action === 'audit') {
          const versionLockAuditFormat = typeof parsed.flags.format === 'string' ? parsed.flags.format : 'markdown';
          if (versionLockAuditFormat !== 'json' && versionLockAuditFormat !== 'markdown') {
            err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown\n`);
            return 1;
          }
          const config = await loadConfig(root);
          const result = await auditVersionLock(root, lockPath, undefined, config);
          if (versionLockAuditFormat === 'json') {
            out(`${JSON.stringify(result, null, 2)}\n`);
          } else {
            out(renderVersionLockAuditMarkdown(result));
          }
          return hasBlockingVersionIssues(result.issues, parsed.flags['strict-missing-lock'] === true) && !parsed.flags['warning-only'] ? 1 : 0;
        }
        if (action === 'update') {
          const target = typeof parsed.flags.target === 'string' ? parsed.flags.target : undefined;
          const source = typeof parsed.flags.source === 'string' ? parsed.flags.source : undefined;
          if (!target || !source) {
            err('Usage: artifact-graph version-lock update --target <type:id> --source <path> [--verified-by <path,path>] [--lock-path <path>]\n');
            return 1;
          }
          const verifiedBy = typeof parsed.flags['verified-by'] === 'string'
            ? parsed.flags['verified-by'].split(',').map((item) => item.trim()).filter(Boolean)
            : undefined;
          const next = await updateVersionLock(root, {
            target,
            source,
            verifiedBy,
            lockPath,
          });
          out(`Updated ${lockPath} (${next.locks.length} locks)\n`);
          return 0;
        }
        if (action === 'bootstrap') {
          const next = await bootstrapVersionLock(root, {
            lockPath,
            force: parsed.flags.force === true,
          });
          out(`Bootstrapped ${lockPath} (${next.locks.length} locks)\n`);
          return 0;
        }
        if (action === 'refresh') {
          const refreshFormat = typeof parsed.flags.format === 'string' ? parsed.flags.format : 'markdown';
          if (refreshFormat !== 'json' && refreshFormat !== 'markdown') {
            err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown\n`);
            return 1;
          }
          const refreshAll = parsed.flags.all === true;
          const refreshChangedOnly = parsed.flags['changed-only'] === true;
          if (!refreshAll && !refreshChangedOnly) {
            err('Usage: artifact-graph version-lock refresh (--all | --changed-only (--staged | --worktree | --base <ref>)) [--remove-orphans] [--format json|markdown] [--lock-path <path>]\n');
            return 1;
          }
          if (parsed.flags.help === true) {
            out('Usage: artifact-graph version-lock refresh (--all | --changed-only (--staged | --worktree | --base <ref>)) [--remove-orphans] [--format json|markdown] [--lock-path <path>]\n');
            return 0;
          }
          if (refreshAll && refreshChangedOnly) {
            err('Error: --all and --changed-only are mutually exclusive\n');
            return 1;
          }

          let changedPaths: string[] = [];
          if (refreshChangedOnly) {
            const changeModeFlags = [
              parsed.flags.staged === true ? 'staged' : null,
              parsed.flags.worktree === true ? 'worktree' : null,
              typeof parsed.flags.base === 'string' ? 'base' : null,
            ].filter(Boolean);
            if (changeModeFlags.length !== 1) {
              err('Usage: artifact-graph version-lock refresh --changed-only (--staged | --worktree | --base <ref>) [--remove-orphans] [--format json|markdown] [--lock-path <path>]\n');
              return 1;
            }
            const changeResult = await collectChangedPaths(root, {
              mode: changeModeFlags[0] as 'staged' | 'worktree' | 'base',
              base: typeof parsed.flags.base === 'string' ? parsed.flags.base : undefined,
            });
            if (changeResult.stagedUnstagedConflictPaths.length > 0) {
              err('Cannot refresh staged version locks because these paths have both staged and unstaged changes:\n');
              for (const conflictPath of changeResult.stagedUnstagedConflictPaths) {
                err(`  - ${conflictPath}\n`);
              }
              err('Stage or stash the unstaged changes before running changed-only staged refresh.\n');
              return 1;
            }
            const unstagedGraphPaths = changeResult.unstagedPaths.filter(isGraphRelevantPath);
            if (unstagedGraphPaths.length > 0) {
              err('Cannot refresh staged version locks because graph-relevant unstaged changes may affect working-tree hashes:\n');
              for (const conflictPath of unstagedGraphPaths) {
                err(`  - ${conflictPath}\n`);
              }
              err('Stage or stash graph-relevant unstaged changes before running changed-only staged refresh.\n');
              return 1;
            }
            changedPaths = changeResult.changedPaths;
          }

          const result = await refreshVersionLock(root, {
            lockPath,
            changedOnly: refreshChangedOnly,
            changedPaths,
            all: refreshAll,
            removeOrphans: parsed.flags['remove-orphans'] === true,
          });
          if (refreshFormat === 'json') {
            out(`${JSON.stringify(result, null, 2)}\n`);
          } else {
            out(renderVersionLockRefreshMarkdown(result));
          }
          return hasBlockingVersionIssues(result.postAudit.issues, true) && !parsed.flags['warning-only'] ? 1 : 0;
        }
        err('Usage: artifact-graph version-lock audit|update|bootstrap|refresh [options]\n');
        return 1;
      }
      case 'trace-version': {
        const target = typeof parsed.flags.target === 'string' ? parsed.flags.target : parsed.positional[0];
        if (!target) {
          err('Usage: artifact-graph trace-version --target <type:id> [--format json|markdown] [--lock-path <path>]\n');
          return 1;
        }
        const lockPath = typeof parsed.flags['lock-path'] === 'string' ? parsed.flags['lock-path'] : VERSION_LOCK_PATH;
        const traceVersionFormat = typeof parsed.flags.format === 'string' ? parsed.flags.format : 'markdown';
        if (traceVersionFormat !== 'json' && traceVersionFormat !== 'markdown') {
          err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown\n`);
          return 1;
        }
        const result = await traceVersion(root, target, lockPath);
        if (traceVersionFormat === 'json') {
          out(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          out(renderTraceVersionMarkdown(result));
        }
        return hasBlockingVersionIssues(result.issues, parsed.flags['strict-missing-lock'] === true) && !parsed.flags['warning-only'] ? 1 : 0;
      }
      case 'hooks': {
        const action = parsed.positional[0];
        if (action !== 'install-git') {
          err('Usage: artifact-graph hooks install-git [--hook pre-commit|pre-push|all] [--uninstall]\n');
          return 1;
        }
        const hookFlag = typeof parsed.flags.hook === 'string' ? parsed.flags.hook : 'all';
        if (hookFlag !== 'all' && hookFlag !== 'pre-commit' && hookFlag !== 'pre-push') {
          err(`Unsupported hook: ${hookFlag}\n`);
          return 1;
        }
        const hooks: Array<'pre-commit' | 'pre-push'> = hookFlag === 'all'
          ? ['pre-commit', 'pre-push']
          : [hookFlag];
        const prepared = [];
        for (const hookName of hooks) {
          const templatePath = fileURLToPath(new URL(`../templates/git-hooks/${hookName}.sh`, import.meta.url));
          const block = await readFile(templatePath, 'utf-8');
          prepared.push(await prepareManagedHookBlock({
            hookPath: await resolveGitHookPath(root, hookName),
            block,
            uninstall: parsed.flags.uninstall === true,
          }));
        }
        const results = await applyPreparedManagedHookBlocks(prepared);
        for (const result of results) {
          out(`${result.action}: ${result.hookPath}\n`);
        }
        return 0;
      }
      case 'doctor': {
        const doctorFormat = typeof parsed.flags.format === 'string' ? parsed.flags.format : 'markdown';
        if (doctorFormat !== 'json' && doctorFormat !== 'markdown') {
          err(`Invalid --format: "${parsed.flags.format}". Allowed values: json, markdown\n`);
          return 1;
        }
        const report = await doctorArtifactChain(root);
        if (doctorFormat === 'json') {
          out(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          const config = await loadConfig(root);
          out(renderDoctorMarkdown(report));
          out(`Types: ${Object.keys(config.types).sort().join(', ')}\n`);
          out(`Forbidden edges: ${config.forbiddenEdges.length}\n`);
        }
        return 0;
      }
      case 'validate-review-result': {
        const filePath = typeof parsed.flags.file === 'string' ? parsed.flags.file : undefined;
        if (!filePath) {
          err('Usage: artifact-graph validate-review-result --file <path> [--format json]\n');
          return 1;
        }
        const resolvedPath = isAbsolute(filePath) ? filePath : join(root, filePath);
        let content: string;
        try {
          content = await readFile(resolvedPath, 'utf-8');
        } catch (readErr) {
          err(`Error: Cannot read file: "${resolvedPath}" — ${(readErr as Error).message}\n`);
          return 1;
        }
        let parsed_json: unknown;
        try {
          parsed_json = JSON.parse(content);
        } catch (parseErr) {
          err(`Error: Invalid JSON in "${resolvedPath}" — ${(parseErr as Error).message}\n`);
          return 1;
        }
        const validationErrors = validateReviewResult(parsed_json);
        if (parsed.flags.format === 'json') {
          out(`${JSON.stringify({ valid: validationErrors.length === 0, errors: validationErrors }, null, 2)}\n`);
        } else if (validationErrors.length === 0) {
          out('Review result is valid\n');
        } else {
          out(`Review result has ${validationErrors.length} error(s):\n`);
          for (const errItem of validationErrors) {
            out(`  ${errItem.path}: ${errItem.message}\n`);
          }
        }
        return validationErrors.length === 0 ? 0 : 1;
      }
      case 'generate-e2e-registry': {
        const checkMode = parsed.flags.check === true;
        const deterministic = checkMode || parsed.flags.deterministic === true;
        const registry = await generateE2eRegistry(root, { deterministic });
        const output = JSON.stringify(registry, null, 2) + '\n';
        const outPath = typeof parsed.flags.out === 'string' ? parsed.flags.out : join(root, 'artifacts/tests/e2e/e2e-test-registry.json');
        if (checkMode) {
          // Check mode: compare with existing file, report drift
          let existing = '';
          try {
            existing = await readFile(outPath, 'utf-8');
          } catch {
            err(`Check failed: ${outPath} does not exist or is not readable\n`);
            return 1;
          }
          if (existing !== output) {
            err(`Registry drift detected: ${outPath} differs from deterministic generation\n`);
            return 1;
          }
          out(`Registry check passed: ${outPath} matches deterministic generation\n`);
          return 0;
        }
        if (typeof parsed.flags.out === 'string') {
          await writeFile(parsed.flags.out, output);
          out(`Registry written to ${parsed.flags.out} (${registry.total_batches} batches, ${registry.total_test_cases} TCs)\n`);
        } else {
          out(output);
        }
        return 0;
      }
      case 'contract': {
        const contractAction = parsed.positional[0];
        const contractFormat = typeof parsed.flags.format === 'string' ? parsed.flags.format : 'json';
        if (contractFormat !== 'json') {
          out(`${JSON.stringify({ ok: false, error: { code: 'INVALID_FORMAT', path: '/format', message: `Invalid --format: "${contractFormat}". Allowed values: json` } }, null, 2)}\n`);
          return 1;
        }

        // Default contracts directory: <package>/contracts
        const packageDir = dirname(fileURLToPath(import.meta.url));
        const contractsDir = typeof parsed.flags['contracts-dir'] === 'string'
          ? parsed.flags['contracts-dir']
          : join(packageDir, '..', 'contracts');

        // Helper to resolve contract with optional --revision-digest
        const revisionDigest = typeof parsed.flags['revision-digest'] === 'string'
          ? parsed.flags['revision-digest']
          : undefined;

        async function resolveContract(contractId: string): Promise<ContractDefinition | undefined> {
          const catalog = await loadContractCatalog(contractsDir);
          if (revisionDigest) {
            return catalog.resolveByDigest(contractId, revisionDigest);
          }
          try {
            return catalog.resolve(contractId);
          } catch (e) {
            if (e instanceof ContractError && e.code === 'AMBIGUOUS_REVISION') {
              // Re-throw to be caught by caller
              throw e;
            }
            return undefined;
          }
        }

        if (contractAction === 'list') {
          const catalog = await loadContractCatalog(contractsDir);
          out(`${JSON.stringify({ ok: true, data: catalog.toJSON() }, null, 2)}\n`);
          return 0;
        }

        if (contractAction === 'explain') {
          const contractId = typeof parsed.flags.contract === 'string' ? parsed.flags.contract : undefined;
          if (!contractId) {
            out(`${JSON.stringify({ ok: false, error: { code: 'CONTRACT_NOT_FOUND', path: '/contract', message: '--contract is required' } }, null, 2)}\n`);
            return 1;
          }
          let contract: ContractDefinition | undefined;
          try {
            contract = await resolveContract(contractId);
          } catch (e) {
            if (e instanceof ContractError && e.code === 'AMBIGUOUS_REVISION') {
              out(`${JSON.stringify({ ok: false, error: { code: 'AMBIGUOUS_REVISION', path: '/contract', message: e.message, details: e.details } }, null, 2)}\n`);
              return 1;
            }
            contract = undefined;
          }
          if (!contract) {
            out(`${JSON.stringify({ ok: false, error: { code: 'CONTRACT_NOT_FOUND', path: '/contract', message: `Contract "${contractId}" not found` } }, null, 2)}\n`);
            return 1;
          }
          out(`${JSON.stringify({ ok: true, data: {
            identity: contract.identity,
            schema: { $id: contract.schema.$id, title: contract.schema.title, version: contract.schema.version },
          } }, null, 2)}\n`);
          return 0;
        }

        if (contractAction === 'validate') {
          const contractId = typeof parsed.flags.contract === 'string' ? parsed.flags.contract : undefined;
          const dataRaw = typeof parsed.flags.data === 'string' ? parsed.flags.data : undefined;
          if (!contractId || !dataRaw) {
            out(`${JSON.stringify({ ok: false, error: { code: 'CONTRACT_NOT_FOUND', path: '/contract', message: '--contract and --data are required' } }, null, 2)}\n`);
            return 1;
          }
          let contract: ContractDefinition | undefined;
          try {
            contract = await resolveContract(contractId);
          } catch (e) {
            if (e instanceof ContractError && e.code === 'AMBIGUOUS_REVISION') {
              out(`${JSON.stringify({ ok: false, error: { code: 'AMBIGUOUS_REVISION', path: '/contract', message: e.message, details: e.details } }, null, 2)}\n`);
              return 1;
            }
            contract = undefined;
          }
          if (!contract) {
            out(`${JSON.stringify({ ok: false, error: { code: 'CONTRACT_NOT_FOUND', path: '/contract', message: `Contract "${contractId}" not found` } }, null, 2)}\n`);
            return 1;
          }
          let data: unknown;
          try {
            data = JSON.parse(dataRaw);
          } catch {
            out(`${JSON.stringify({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', path: '/data', message: '--data is not valid JSON' } }, null, 2)}\n`);
            return 1;
          }
          const schemaResult = validateContractAgainstSchema(data, contract);
          if (!schemaResult.valid) {
            out(`${JSON.stringify({ ok: false, errors: schemaResult.errors.map(e => ({ code: 'SCHEMA_VALIDATION_FAILED', path: '/', message: e })) }, null, 2)}\n`);
            return 1;
          }
          // Also validate relations if present
          const dataObj = data as Record<string, unknown>;
          if (Array.isArray(dataObj.relations)) {
            const relationResult = validateRelations(dataObj.relations as Array<Record<string, unknown>>, contract);
            if (!relationResult.valid) {
              out(`${JSON.stringify({ ok: false, errors: relationResult.issues }, null, 2)}\n`);
              return 1;
            }
          }
          out(`${JSON.stringify({ ok: true, data: { valid: true, issues: [] } }, null, 2)}\n`);
          return 0;
        }

        if (contractAction === 'check-policy') {
          const contractId = typeof parsed.flags.contract === 'string' ? parsed.flags.contract : undefined;
          const policyRaw = typeof parsed.flags.policy === 'string' ? parsed.flags.policy : undefined;
          if (!contractId || !policyRaw) {
            out(`${JSON.stringify({ ok: false, error: { code: 'CONTRACT_NOT_FOUND', path: '/contract', message: '--contract and --policy are required' } }, null, 2)}\n`);
            return 1;
          }
          let contract: ContractDefinition | undefined;
          try {
            contract = await resolveContract(contractId);
          } catch (e) {
            if (e instanceof ContractError && e.code === 'AMBIGUOUS_REVISION') {
              out(`${JSON.stringify({ ok: false, error: { code: 'AMBIGUOUS_REVISION', path: '/contract', message: e.message, details: e.details } }, null, 2)}\n`);
              return 1;
            }
            contract = undefined;
          }
          if (!contract) {
            out(`${JSON.stringify({ ok: false, error: { code: 'CONTRACT_NOT_FOUND', path: '/contract', message: `Contract "${contractId}" not found` } }, null, 2)}\n`);
            return 1;
          }
          let policy: ProjectPolicy;
          try {
            policy = JSON.parse(policyRaw) as ProjectPolicy;
          } catch {
            out(`${JSON.stringify({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', path: '/policy', message: '--policy is not valid JSON' } }, null, 2)}\n`);
            return 1;
          }
          const result = validatePolicyCompatibility(policy, contract);
          if (!result.compatible) {
            out(`${JSON.stringify({ ok: false, errors: result.errors.map(message => ({ code: 'POLICY_INCOMPATIBLE', path: '/policy', message })) }, null, 2)}\n`);
            return 1;
          }
          out(`${JSON.stringify({ ok: true, data: { compatible: true, warnings: result.warnings } }, null, 2)}\n`);
          return 0;
        }

        if (contractAction === 'normalize') {
          const contractId = typeof parsed.flags.contract === 'string' ? parsed.flags.contract : undefined;
          const dataRaw = typeof parsed.flags.data === 'string' ? parsed.flags.data : undefined;
          if (!contractId || !dataRaw) {
            out(`${JSON.stringify({ ok: false, error: { code: 'CONTRACT_NOT_FOUND', path: '/contract', message: '--contract and --data are required' } }, null, 2)}\n`);
            return 1;
          }
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataRaw) as Record<string, unknown>;
          } catch {
            out(`${JSON.stringify({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', path: '/data', message: '--data is not valid JSON' } }, null, 2)}\n`);
            return 1;
          }
          let contract: ContractDefinition | undefined;
          try {
            contract = await resolveContract(contractId);
          } catch (e) {
            if (e instanceof ContractError && e.code === 'AMBIGUOUS_REVISION') {
              out(`${JSON.stringify({ ok: false, error: { code: 'AMBIGUOUS_REVISION', path: '/contract', message: e.message, details: e.details } }, null, 2)}\n`);
              return 1;
            }
            contract = undefined;
          }
          if (!contract) {
            out(`${JSON.stringify({ ok: false, error: { code: 'CONTRACT_NOT_FOUND', path: '/contract', message: `Contract "${contractId}" not found` } }, null, 2)}\n`);
            return 1;
          }
          const { normalizeE2eLegacyArtifact } = await import('./contract-kernel.js');
          const result = normalizeE2eLegacyArtifact(data, contract);
          if (!result.success) {
            out(`${JSON.stringify({ ok: false, errors: result.errors }, null, 2)}\n`);
            return 1;
          }
          out(`${JSON.stringify({ ok: true, data: result }, null, 2)}\n`);
          return 0;
        }

        if (contractAction === 'validate-markers') {
          const contractId = typeof parsed.flags.contract === 'string' ? parsed.flags.contract : undefined;
          const markdownPath = typeof parsed.flags.markdown === 'string' ? parsed.flags.markdown : undefined;
          if (!contractId || !markdownPath) {
            out(`${JSON.stringify({ ok: false, error: { code: 'CONTRACT_NOT_FOUND', path: '/contract', message: '--contract and --markdown are required' } }, null, 2)}\n`);
            return 1;
          }
          let contract: ContractDefinition | undefined;
          try {
            contract = await resolveContract(contractId);
          } catch (e) {
            if (e instanceof ContractError && e.code === 'AMBIGUOUS_REVISION') {
              out(`${JSON.stringify({ ok: false, error: { code: 'AMBIGUOUS_REVISION', path: '/contract', message: e.message, details: e.details } }, null, 2)}\n`);
              return 1;
            }
            contract = undefined;
          }
          if (!contract) {
            out(`${JSON.stringify({ ok: false, error: { code: 'CONTRACT_NOT_FOUND', path: '/contract', message: `Contract "${contractId}" not found` } }, null, 2)}\n`);
            return 1;
          }
          let markdownContent: string;
          try {
            markdownContent = await readFile(markdownPath, 'utf-8');
          } catch {
            out(`${JSON.stringify({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', path: '/markdown', message: `Could not read markdown file "${markdownPath}"` } }, null, 2)}\n`);
            return 1;
          }
          const { validateSemanticMarkers } = await import('./contract-kernel.js');
          const result = validateSemanticMarkers(markdownContent, contract);
          if (!result.valid) {
            out(`${JSON.stringify({ ok: false, errors: result.errors.map(e => ({ code: 'MARKER_VALIDATION_FAILED', path: '/', message: e })) }, null, 2)}\n`);
            return 1;
          }
          out(`${JSON.stringify({ ok: true, data: { valid: true, issues: [] } }, null, 2)}\n`);
          return 0;
        }

        out(`${JSON.stringify({ ok: false, error: { code: 'INVALID_COMMAND', path: '/command', message: 'Usage: artifact-graph contract list|explain|validate|normalize|check-policy|validate-markers [options]' } }, null, 2)}\n`);
        return 1;
      }
      default:
        err(helpText());
        return 1;
    }
  } catch (error) {
    if (parsed.command === 'contract') {
      const contractError = error as Partial<ContractError> & Error;
      out(`${JSON.stringify({ ok: false, error: {
        code: contractError.code ?? 'CONTRACT_INTERNAL_ERROR',
        path: '/contract',
        message: contractError.message,
        ...(contractError.details ? { details: contractError.details } : {}),
      } }, null, 2)}\n`);
      return 1;
    }
    err(`${(error as Error).message}\n`);
    return 1;
  }
}

function hasBlockingVersionIssues(issues: Array<{ status: string }>, strictMissingLock: boolean): boolean {
  return issues.some((issue) => issue.status !== 'missing_lock' || strictMissingLock);
}

function isGraphRelevantPath(path: string): boolean {
  return path === 'artifact-graph.config.yaml'
    || path === VERSION_LOCK_PATH
    || path.startsWith('artifacts/')
    || /\.(md|mdx|json|ya?ml|ts|tsx|js|jsx|mts|cts|rs|py|go)$/.test(path);
}

async function initConfig(root: string): Promise<void> {
  const configPath = join(root, 'artifact-graph.config.yaml');
  try {
    await access(configPath);
    throw new Error(`Config already exists: ${configPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await mkdir(root, { recursive: true });
  await writeFile(configPath, yaml.dump(DEFAULT_SCHEMA, { lineWidth: 120 }));
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[index + 1];
      // A value starting with '-' followed by a letter is a flag, not a value for this flag.
      // A value starting with '-' followed by a digit (e.g. -1) is a negative number and IS a value.
      const nextLooksLikeFlag = next && next.startsWith('-') && next.length > 1 && !/\d/.test(next[1]);
      if (next && !nextLooksLikeFlag) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else if (token === '-h') {
      // Handle -h as help flag
      flags.help = true;
    } else if (token.startsWith('-') && token.length > 1) {
      // Handle other short flags
      const key = token.slice(1);
      flags[key] = true;
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function helpText(): string {
  return `artifact-graph <command>

Commands:
  init
  scan
  validate [--format json] [--warning-only] [--include scenario-prd-links,e2e-coverage]
  query --from <code> [--format json]
  context (--target <type>:<id> | --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id>) [--mode full|implementation] [--max-per-category <n>] [--format json]
  packet (--target <type>:<id> | --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id>) [--mode full|implementation] [--max-per-category <n>] [--format json|markdown] [--out <path>] [--no-validate]
  packet-prompt (--target <type>:<id> | --feature <id> | --scenario <id> | --decision <id> | --design <id> | --e2e-test <id> | --packet <path>) [--max-chars <n>] [--format markdown] [--out <path>]
  packet-audit (--targets-file <path> | --discover) [--out-dir <path>] [--limit <n>] [--format json|markdown] [--mode full|implementation] [--max-per-category <n>] [--summary-only] [--sample-targets <type:id,...>] [--summary-detail full|compact]
  packet-prompt-audit (--targets-file <path> | --discover) [--out-dir <path>] [--format json|markdown] [--max-chars <n>] [--limit <n>] [--summary-only] [--summary-detail full|compact]
  version-index [--format json] [--out <path>]
  version-lock audit [--format json|markdown] [--warning-only] [--strict-missing-lock] [--lock-path <path>]
  version-lock update --target <type:id> --source <path> [--verified-by <path,path>] [--lock-path <path>]
  version-lock bootstrap [--force] [--lock-path <path>]
  version-lock refresh (--all | --changed-only (--staged | --worktree | --base <ref>)) [--remove-orphans] [--format json|markdown] [--lock-path <path>]
  trace-version --target <type:id> [--format json|markdown] [--warning-only] [--strict-missing-lock] [--lock-path <path>]
  hooks install-git [--hook pre-commit|pre-push|all] [--uninstall]
  next-id <type> --range <name>
  render [--format mermaid]
  doctor [--format json|markdown]
  validate-review-result --file <path> [--format json]
  generate-e2e-registry [--deterministic] [--out <path>] [--check]
  contract list [--contracts-dir <path>] [--format json]
  contract explain --contract <major-id> [--contracts-dir <path>] [--format json]
  contract validate --contract <major-id> --data <json> [--contracts-dir <path>] [--format json]
  contract normalize --contract <major-id> --data <json> [--format json]
  contract check-policy --contract <major-id> --policy <json> [--contracts-dir <path>] [--format json]
  contract validate-markers --contract <major-id> --markdown <path> [--contracts-dir <path>] [--format json]
`;
}

function isCliEntrypoint(argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntrypoint(process.argv[1])) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
