#!/usr/bin/env node
interface CliIo {
    cwd?: string;
    stdout?: (chunk: string) => void;
    stderr?: (chunk: string) => void;
}
declare function runCli(argv: string[], io?: CliIo): Promise<number>;

export { type CliIo, runCli };
