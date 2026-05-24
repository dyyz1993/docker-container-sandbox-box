/**
 * Sandbox-Box Extension - Remote sandbox proxy for pi coding agent
 *
 * Uses ToolOperationsProvider to proxy ALL built-in tools (bash, read, write,
 * edit, grep, find, ls) to remote sandboxes via SSH. When in remote mode,
 * the agent operates entirely inside the sandbox.
 *
 * Config: ~/.pi/agent/sandbox-box.json or .pi/sandbox-box.json
 *
 * Usage:
 *   pi -e ./pi-extension                    # local mode
 *   pi -e ./pi-extension --sandbox-box      # remote mode
 *   /sandbox-box                             # status
 *   /sandbox-box remote|local                # switch mode
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@dyyz1993/pi-coding-agent";
import {
	type BashOperations,
	type ReadOperations,
	type WriteOperations,
	type EditOperations,
	type GrepOperations,
	type FindOperations,
	type LsOperations,
	type ToolOperationsProvider,
	type ToolDefinition,
	getAgentDir,
} from "@dyyz1993/pi-coding-agent";

interface SandboxBoxConfig {
	mode: "local" | "remote";
	host: string;
	port: number;
	sandboxPrefix: string;
	destroyOnExit: boolean;
}

interface State {
	currentMode: "local" | "remote";
	connected: boolean;
	sandboxName: string;
	sandboxCreated: boolean;
}

// ============================================================================
// SSH Helper
// ============================================================================

function execSsh(
	host: string, port: number, cmd: string, timeout = 30,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [
			"-o", "StrictHostKeyChecking=no",
			"-o", "ConnectTimeout=10",
			"-o", "ServerAliveInterval=30",
			"-o", "ServerAliveCountMax=3",
			"-p", String(port),
			`root@${host}`,
			cmd,
		], { stdio: ["ignore", "pipe", "pipe"] });

		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeout * 1000);

		child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
		child.on("error", (err) => { clearTimeout(timer); reject(new Error(`SSH failed: ${err.message}`)); });
		child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr }); });
	});
}

// ============================================================================
// Sandbox Management
// ============================================================================

async function testConnection(host: string, port: number): Promise<boolean> {
	try {
		const { exitCode } = await execSsh(host, port, "echo ok", 15);
		return exitCode === 0;
	} catch { return false; }
}

async function checkSandboxExists(host: string, port: number, name: string): Promise<boolean> {
	try {
		const { exitCode, stdout } = await execSsh(host, port, "sandbox list", 15);
		if (exitCode !== 0) return false;
		return stdout.split("\n").some((l) => l.trim().startsWith(name) && l.includes("running"));
	} catch { return false; }
}

async function createSandbox(host: string, port: number, name: string): Promise<boolean> {
	try {
		const { exitCode, stdout } = await execSsh(host, port, `sandbox create ${name}`, 30);
		if (exitCode === 0) return true;
		if (stdout?.includes("already running") || stdout?.includes("already exists")) return true;
		return false;
	} catch { return false; }
}

async function destroySandbox(host: string, port: number, name: string): Promise<boolean> {
	try {
		const { exitCode } = await execSsh(host, port, `sandbox destroy ${name}`, 15);
		return exitCode === 0;
	} catch { return false; }
}

// ============================================================================
// Remote Operations Factories
// ============================================================================

function createRemoteBashOps(host: string, port: number, sandboxName: string): BashOperations {
	return {
		async exec(command, _cwd, { onData, signal, timeout }) {
			const escapedCommand = command.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
			const remoteCmd = `sandbox ${sandboxName} bash -c '${escapedCommand}'`;
			const sshArgs = [
				"-o", "StrictHostKeyChecking=no",
				"-o", "ConnectTimeout=10",
				"-o", "ServerAliveInterval=30",
				"-o", "ServerAliveCountMax=3",
				"-p", String(port),
				`root@${host}`,
				remoteCmd,
			];

			return new Promise((resolve, reject) => {
				const child = spawn("ssh", sshArgs, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				let timer: NodeJS.Timeout | undefined;

				if (timeout && timeout > 0) {
					timer = setTimeout(() => {
						timedOut = true;
						if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
					}, timeout * 1000);
				}

				child.stdout?.on("data", (d: Buffer) => onData(d));
				child.stderr?.on("data", (d: Buffer) => onData(d));
				child.on("error", (err) => { if (timer) clearTimeout(timer); reject(new Error(`SSH failed: ${err.message}`)); });

				const onAbort = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } };
				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			});
		},
	};
}

function createRemoteReadOps(host: string, port: number, sandboxName: string): ReadOperations {
	return {
		async readFile(absolutePath: string): Promise<Buffer> {
			const escapedPath = absolutePath.replace(/'/g, "'\\''");
			const { exitCode, stdout } = await execSsh(host, port, `sandbox ${sandboxName} cat '${escapedPath}'`);
			if (exitCode !== 0) throw new Error(`Failed to read ${absolutePath}`);
			return Buffer.from(stdout, "utf-8");
		},
		async access(absolutePath: string): Promise<void> {
			const escapedPath = absolutePath.replace(/'/g, "'\\''");
			const { exitCode } = await execSsh(host, port, `sandbox ${sandboxName} test -r '${escapedPath}'`);
			if (exitCode !== 0) throw new Error(`Cannot access ${absolutePath}`);
		},
	};
}

function createRemoteWriteOps(host: string, port: number, sandboxName: string): WriteOperations {
	return {
		async writeFile(absolutePath: string, content: string): Promise<void> {
			const escapedPath = absolutePath.replace(/'/g, "'\\''");
			const sshArgs = [
				"-o", "StrictHostKeyChecking=no",
				"-o", "ConnectTimeout=10",
				"-p", String(port),
				`root@${host}`,
				`sandbox ${sandboxName} tee '${escapedPath}'`,
			];
			const { exitCode } = await new Promise<{ exitCode: number | null }>((resolve, reject) => {
				const child = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
				child.stdin?.write(content);
				child.stdin?.end();
				child.on("error", (err) => reject(new Error(`SSH write failed: ${err.message}`)));
				child.on("close", (code) => resolve({ exitCode: code }));
			});
			if (exitCode !== 0) throw new Error(`Failed to write ${absolutePath}`);
		},
		async mkdir(dir: string): Promise<void> {
			const escapedDir = dir.replace(/'/g, "'\\''");
			await execSsh(host, port, `sandbox ${sandboxName} mkdir -p '${escapedDir}'`);
		},
	};
}

function createRemoteEditOps(host: string, port: number, sandboxName: string): EditOperations {
	const readOps = createRemoteReadOps(host, port, sandboxName);
	const writeOps = createRemoteWriteOps(host, port, sandboxName);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}

function createRemoteGrepOps(host: string, port: number, sandboxName: string): GrepOperations {
	return {
		async isDirectory(absolutePath: string): Promise<boolean> {
			const escapedPath = absolutePath.replace(/'/g, "'\\''");
			const { exitCode } = await execSsh(host, port, `sandbox ${sandboxName} test -d '${escapedPath}'`);
			return exitCode === 0;
		},
		async readFile(absolutePath: string): Promise<string> {
			const escapedPath = absolutePath.replace(/'/g, "'\\''");
			const { exitCode, stdout } = await execSsh(host, port, `sandbox ${sandboxName} cat '${escapedPath}'`);
			if (exitCode !== 0) return "";
			return stdout;
		},
	};
}

function createRemoteFindOps(host: string, port: number, sandboxName: string): FindOperations {
	return {
		async exists(absolutePath: string): Promise<boolean> {
			const escapedPath = absolutePath.replace(/'/g, "'\\''");
			const { exitCode } = await execSsh(host, port, `sandbox ${sandboxName} test -e '${escapedPath}'`);
			return exitCode === 0;
		},
		async glob(pattern: string, cwd: string, options: { ignore: string[]; limit: number }): Promise<string[]> {
			const ignoreArgs = options.ignore.map((i) => `-not -path '${i}'`).join(" ");
			const { stdout } = await execSsh(
				host, port,
				`sandbox ${sandboxName} find '${cwd}' -name '${pattern}' -type f ${ignoreArgs} 2>/dev/null | head -${options.limit}`,
			);
			return stdout.trim().split("\n").filter(Boolean);
		},
	};
}

function createRemoteLsOps(host: string, port: number, sandboxName: string): LsOperations {
	return {
		async exists(absolutePath: string): Promise<boolean> {
			const escapedPath = absolutePath.replace(/'/g, "'\\''");
			const { exitCode } = await execSsh(host, port, `sandbox ${sandboxName} test -e '${escapedPath}'`);
			return exitCode === 0;
		},
		async stat(absolutePath: string): Promise<{ isDirectory: () => boolean }> {
			const escapedPath = absolutePath.replace(/'/g, "'\\''");
			const { exitCode, stdout } = await execSsh(host, port, `sandbox ${sandboxName} stat -c '%F' '${escapedPath}'`);
			if (exitCode !== 0) throw new Error(`Cannot stat ${absolutePath}`);
			return { isDirectory: () => stdout.trim().includes("directory") };
		},
		async readdir(absolutePath: string): Promise<string[]> {
			const escapedPath = absolutePath.replace(/'/g, "'\\''");
			const { exitCode, stdout } = await execSsh(host, port, `sandbox ${sandboxName} ls -1 '${escapedPath}'`);
			if (exitCode !== 0) throw new Error(`Cannot readdir ${absolutePath}`);
			return stdout.trim().split("\n").filter(Boolean);
		},
	};
}

function createRemoteOpsProvider(host: string, port: number, sandboxName: string): ToolOperationsProvider {
	return {
		bash: createRemoteBashOps(host, port, sandboxName),
		read: createRemoteReadOps(host, port, sandboxName),
		write: createRemoteWriteOps(host, port, sandboxName),
		edit: createRemoteEditOps(host, port, sandboxName),
		grep: createRemoteGrepOps(host, port, sandboxName),
		find: createRemoteFindOps(host, port, sandboxName),
		ls: createRemoteLsOps(host, port, sandboxName),
	};
}

function createRemoteBashToolDefinition(host: string, port: number, sandboxName: string): ToolDefinition {
	const ops = createRemoteBashOps(host, port, sandboxName);
	return {
		name: "bash",
		label: "bash (sandbox)",
		description: "Execute a bash command in the remote sandbox via SSH.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The bash command to execute" },
				timeout: { type: "number", description: "Timeout in seconds" },
			},
			required: ["command"],
		} as any,
		async execute(_id, params: { command: string; timeout?: number; workdir?: string }, signal?: AbortSignal) {
			const output: Buffer[] = [];
			try {
				const { exitCode } = await ops.exec(params.command, params.workdir || "/workspace", {
					onData: (data: Buffer) => output.push(data),
					signal,
					timeout: params.timeout,
				});
				const text = Buffer.concat(output).toString("utf-8");
				return {
					content: [{ type: "text" as const, text: text || `(exit code: ${exitCode})` }],
					details: undefined,
				};
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `Error: ${err.message}` }],
					details: undefined,
				};
			}
		},
	};
}

// ============================================================================
// Config
// ============================================================================

const DEFAULT_CONFIG: SandboxBoxConfig = {
	mode: "local",
	host: "192.168.0.29",
	port: 2201,
	sandboxPrefix: "pi-",
	destroyOnExit: false,
};

function loadConfig(cwd: string): SandboxBoxConfig {
	const configs: Partial<SandboxBoxConfig>[] = [];
	const agentDir = getAgentDir();
	const globalPath = join(agentDir, "sandbox-box.json");
	const projectPath = join(cwd, ".pi", "sandbox-box.json");

	if (existsSync(globalPath)) {
		try { configs.push(JSON.parse(readFileSync(globalPath, "utf-8"))); } catch { /* skip */ }
	}
	if (existsSync(projectPath)) {
		try { configs.push(JSON.parse(readFileSync(projectPath, "utf-8"))); } catch { /* skip */ }
	}

	return { ...DEFAULT_CONFIG, ...configs[0], ...configs[1] };
}

function saveProjectConfig(cwd: string, partial: Partial<SandboxBoxConfig>) {
	const dir = join(cwd, ".pi");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const path = join(dir, "sandbox-box.json");
	const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
	writeFileSync(path, JSON.stringify({ ...existing, ...partial }, null, 2));
}

function getProjectName(cwd: string): string {
	return basename(cwd).replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
}

// ============================================================================
// Extension
// ============================================================================

export default function sandboxBoxExtension(pi: ExtensionAPI) {
	const localCwd = process.cwd();
	const config = loadConfig(localCwd);

	let activeHost = config.host;
	let activePort = config.port;

	const state: State = {
		currentMode: config.mode,
		connected: false,
		sandboxName: `${config.sandboxPrefix}${getProjectName(localCwd)}`,
		sandboxCreated: false,
	};

	const flagEnabled = pi.getFlag("sandbox-box");
	const flagHost = pi.getFlag("sandbox-box-host") as string | undefined;
	const flagPort = pi.getFlag("sandbox-box-port") as string | undefined;
	if (flagHost) activeHost = flagHost;
	if (flagPort) activePort = parseInt(flagPort, 10) || config.port;
	if (flagEnabled) state.currentMode = "remote";

	function updateStatusBar(ctx: { ui: any }): void {
		if (state.currentMode === "remote" && state.connected) {
			ctx.ui.setStatus("sandbox-box", `Sandbox: ${state.sandboxName} @ ${activeHost}:${activePort}`);
		} else if (state.currentMode === "remote" && !state.connected) {
			ctx.ui.setStatus("sandbox-box", `Sandbox: ${state.sandboxName} (connecting...)`);
		} else {
			ctx.ui.setStatus("sandbox-box", undefined);
		}
	}

	let remoteBashRegistered = false;

	function activateRemote(ctx: { ui: any }) {
		const provider = createRemoteOpsProvider(activeHost, activePort, state.sandboxName);
		pi.setToolOperationsProvider(provider);
		if (!remoteBashRegistered) {
			pi.registerTool(createRemoteBashToolDefinition(activeHost, activePort, state.sandboxName));
			remoteBashRegistered = true;
		}
		updateStatusBar(ctx);
	}

	function deactivateRemote(ctx: { ui: any }) {
		pi.setToolOperationsProvider(undefined);
		updateStatusBar(ctx);
	}

	pi.on("user_bash", () => {
		if (state.currentMode !== "remote" || !state.connected) return;
		return { operations: createRemoteBashOps(activeHost, activePort, state.sandboxName) };
	});

	pi.on("session_start", async (_event, ctx) => {
		if (state.currentMode !== "remote") {
			ctx.ui.notify("Sandbox-Box: Local mode", "info");
			return;
		}

		ctx.ui.notify(`Sandbox-Box: Connecting to ${activeHost}:${activePort}...`, "info");
		updateStatusBar(ctx);

		const connected = await testConnection(activeHost, activePort);
		if (!connected) {
			state.connected = false;
			ctx.ui.notify(`Sandbox-Box: Failed to connect. Falling back to local.`, "error");
			state.currentMode = "local";
			updateStatusBar(ctx);
			return;
		}

		state.connected = true;

		const exists = await checkSandboxExists(activeHost, activePort, state.sandboxName);
		if (!exists) {
			ctx.ui.notify(`Sandbox-Box: Creating sandbox "${state.sandboxName}"...`, "info");
			const created = await createSandbox(activeHost, activePort, state.sandboxName);
			if (!created) {
				state.connected = false;
				state.currentMode = "local";
				updateStatusBar(ctx);
				ctx.ui.notify(`Sandbox-Box: Failed to create. Falling back to local.`, "error");
				return;
			}
		}
		state.sandboxCreated = true;

		activateRemote(ctx);
		ctx.ui.notify(`Sandbox-Box: Remote active - "${state.sandboxName}" on ${activeHost}:${activePort}`, "info");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (state.currentMode === "remote" && state.sandboxCreated && config.destroyOnExit) {
			ctx?.ui?.notify?.(`Sandbox-Box: Destroying "${state.sandboxName}"...`, "info");
			await destroySandbox(activeHost, activePort, state.sandboxName);
			state.sandboxCreated = false;
		}
		pi.setToolOperationsProvider(undefined);
		ctx?.ui?.setStatus?.("sandbox-box", undefined);
	});

	pi.registerCommand("sandbox-box", {
		description: "Manage sandbox-box mode (status / local / remote)",
		getArgumentCompletions: (prefix: string) => {
			return ["status", "local", "remote"]
				.filter((o) => o.startsWith(prefix))
				.map((s) => ({ value: s, label: s })) || null;
		},
		handler: async (args: string, ctx) => {
			const subcommand = args.trim().split(/\s+/)[0] || "status";

			switch (subcommand) {
				case "status": {
					const lines = [
						"Sandbox-Box Status:",
						`  Mode:       ${state.currentMode}`,
						`  Sandbox:    ${state.sandboxName}`,
						`  Host:       ${activeHost}:${activePort}`,
						`  Connected:  ${state.connected}`,
						`  Created:    ${state.sandboxCreated}`,
						`  Destroy on exit: ${config.destroyOnExit}`,
						"",
						"Commands:",
						"  /sandbox-box local  - switch to local mode",
						"  /sandbox-box remote - switch to remote mode",
					];
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				case "local": {
					const prev = state.currentMode;
					state.currentMode = "local";
					state.connected = false;
					deactivateRemote(ctx);
					ctx.ui.notify(
						prev === "remote" ? "Sandbox-Box: Switched to local mode" : "Sandbox-Box: Already in local mode",
						"info",
					);
					saveProjectConfig(localCwd, { mode: "local" });
					break;
				}

				case "remote": {
					if (state.currentMode === "remote" && state.connected) {
						ctx.ui.notify("Sandbox-Box: Already in remote mode", "info");
						return;
					}

					ctx.ui.notify(`Sandbox-Box: Connecting to ${activeHost}:${activePort}...`, "info");
					state.currentMode = "remote";
					updateStatusBar(ctx);

					const connected = await testConnection(activeHost, activePort);
					if (!connected) {
						state.connected = false;
						state.currentMode = "local";
						updateStatusBar(ctx);
						ctx.ui.notify(`Sandbox-Box: Failed to connect. Staying local.`, "error");
						return;
					}

					state.connected = true;
					const exists = await checkSandboxExists(activeHost, activePort, state.sandboxName);
					if (!exists) {
						ctx.ui.notify(`Sandbox-Box: Creating "${state.sandboxName}"...`, "info");
						const created = await createSandbox(activeHost, activePort, state.sandboxName);
						if (!created) {
							state.connected = false;
							state.currentMode = "local";
							updateStatusBar(ctx);
							ctx.ui.notify(`Sandbox-Box: Failed to create. Staying local.`, "error");
							return;
						}
					}
					state.sandboxCreated = true;

					activateRemote(ctx);
					ctx.ui.notify(`Sandbox-Box: Remote active - "${state.sandboxName}"`, "info");
					saveProjectConfig(localCwd, { mode: "remote" });
					break;
				}
			}
		},
	});
}
