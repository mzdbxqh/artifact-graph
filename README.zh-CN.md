# artifact-graph

[English](README.md)

`artifact-graph` 是面向 AI 编程工作流的 Git-native Markdown 制品图扫描和校验工具。

它帮助项目把需求、场景、设计、源码、测试和 version-lock 元数据连接起来，在 AI agent
声称实现完成之前，用确定性本地命令检查上下文和追溯关系。

## 安装

```bash
pnpm add -D artifact-graph
```

需要 Node.js `>=22.0.0`。

## 快速开始

```bash
artifact-graph init --root .
artifact-graph validate --root . --warning-only
artifact-graph version-lock refresh --changed-only --staged --format markdown
artifact-graph version-lock audit --root . --strict-missing-lock
```

## 常见工作流

- 用 `artifact-graph init` 生成或检查项目制品图配置。
- 用 `artifact-graph validate` 校验制品之间的链接。
- 用 `artifact-graph context` 或 `artifact-graph packet` 构建实现上下文。
- 用 `artifact-graph version-lock refresh` 和 `audit` 维护追溯新鲜度。
- 用 `artifact-graph hooks install-git --hook all` 安装可选 Git hooks。

## 相关项目

如果需要 Codex / Claude Code 的技能、初始化引导和维护流程，请使用
[`artifact-chain-assistant`](https://github.com/mzdbxqh/artifact-chain-assistant)。

## 开源协议

Apache-2.0。详见 [LICENSE](LICENSE)。
