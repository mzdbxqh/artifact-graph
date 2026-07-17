# artifact-graph

[English](README.md)

`artifact-graph` 是面向 AI 编程工作流的 Git-native Markdown 制品图扫描和校验工具。

它帮助项目把需求、场景、设计、源码、测试和 version-lock 元数据连接起来，在 AI agent
声称实现完成之前，用确定性本地命令检查上下文和追溯关系。

## 安装

```bash
pnpm add -D artifact-graph
```

或从 GitHub 安装：

```bash
npm install --save-dev github:mzdbxqh/artifact-graph
```

需要 Node.js `>=22.0.0`。pnpm 10+ 需要配置原生构建白名单，详见 [INSTALL.md](INSTALL.md)。

## 快速开始

```bash
# pnpm
pnpm exec artifact-graph init --root .
pnpm exec artifact-graph validate --root . --warning-only
pnpm exec artifact-graph version-lock refresh --all --format markdown
pnpm exec artifact-graph version-lock audit --root . --strict-missing-lock

# npm
npx artifact-graph init --root .
npx artifact-graph validate --root . --warning-only
npx artifact-graph version-lock refresh --all --format markdown
npx artifact-graph version-lock audit --root . --strict-missing-lock
```

> 首次初始化版本锁使用 `version-lock refresh --all`。`--changed-only --staged` 适用于
> 已有项目的 pre-commit hook，不适用于首次初始化。

## 常见工作流

- 用 `artifact-graph init` 生成或检查项目制品图配置。
- 用 `artifact-graph validate` 校验制品之间的链接。
- 用 `artifact-graph validate-review-result --file <path>` 校验 Review Result Protocol v1.0 文档。
- 用 `artifact-graph context` 或 `artifact-graph packet` 构建实现上下文。
- 用 `artifact-graph version-lock refresh` 和 `audit` 维护追溯新鲜度。
- 用 `artifact-graph hooks install-git --hook all` 安装可选 Git hooks。

## Review Result Protocol

包内发布 `schemas/review-result.schema.json` 和等价的 TypeScript 类型与 validateReviewResult 校验 API。该协议不绑定具体
项目，覆盖 review、repair、批次证据、findings、metrics 与 fail-closed decision；非法字段
会返回稳定的 JSON path 诊断。协议拒绝未知顶层字段，`attempt` 仅允许 1–3；成功接受必须包含
`producer`，`PASS`/`PASS_WITH_RESIDUAL_MINOR` 不能伴随 open `block` finding。独立 repair
re-review 可记录 `acceptance.reviewer` 与 `acceptance.source_result`，validator 会拒绝 repair
producer 自行接受。
JSON Schema 无法比较跨对象字段值，因此调用方还必须运行 semantic validator；稳定身份是
`executor + name`，`skill` 只是附加元数据，不能用于证明独立性。

## 相关项目

如果需要 Codex / Claude Code 的技能、初始化引导和维护流程，请使用
[`artifact-chain-assistant`](https://github.com/mzdbxqh/artifact-chain-assistant)。

## 开源协议

Apache-2.0。详见 [LICENSE](LICENSE)。
