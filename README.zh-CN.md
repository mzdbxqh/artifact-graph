# artifact-graph

[English](README.md)

`artifact-graph` 是一个 Git 原生的 Markdown 制品图扫描与校验工具，面向 AI 编程工作流。

它把项目里的需求、场景、设计、源码、测试和 version-lock 元数据连成一张图，
供 AI agent 在宣称实现完成之前，用确定性的本地命令检查上下文和追溯关系。

## 安装

```bash
pnpm add -D artifact-graph
```

或从 GitHub 安装：

```bash
npm install --save-dev github:ifoohoo/artifact-graph
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
- 用 `artifact-graph version-lock refresh` 和 `audit` 保持追溯关系及时更新。
- 用 `artifact-graph hooks install-git --hook all` 安装可选 Git hooks。

## Review Result Protocol

包内发布了 `schemas/review-result.schema.json`，以及配套的 TypeScript 类型和 `validateReviewResult`
校验 API。该协议与具体项目无关，覆盖 review、repair、批次证据、findings、metrics 和
fail-closed decision；非法字段和语义违规都会以稳定的 JSON path 报告。协议拒绝未知顶层字段；
`attempt` 取值仅限 1–3；成功接受必须带 `producer`；`PASS`/`PASS_WITH_RESIDUAL_MINOR` 不允许
存在未关闭的 `block` finding。独立的 repair 复审可以记录 `acceptance.reviewer` 和
`acceptance.source_result`，validator 会拒绝 repair producer 自我接受。
JSON Schema 无法比较跨对象的字段值，因此调用方还必须运行语义 validator；稳定身份由
`executor + name` 构成，`skill` 只是附加元数据，不能用来证明独立性。

## 相关项目

如果需要 Codex / Claude Code 技能来引导制品链的接入、初始化和日常维护，请使用
[`artifact-chain-assistant`](https://github.com/ifoohoo/artifact-chain-assistant)。

## 开源协议

Apache-2.0。详见 [LICENSE](LICENSE)。
