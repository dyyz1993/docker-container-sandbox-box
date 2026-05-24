/**
 * Sandbox-Bash Extension for pi v0.74.54
 *
 * Overrides the built-in bash tool to route commands through `sandbox <name> <cmd>`.
 * Also provides switch_sandbox and list_sandboxes tools.
 *
 * Config: reads sandbox name from /root/data/active-sandbox or PI_SANDBOX env.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@dyyz1993/pi-coding-agent";

const ACTIVE_SANDBOX_FILE = "/root/data/active-sandbox";

function getActiveSandbox(): string | null {
	if (process.env.PI_SANDBOX) return process.env.PI_SANDBOX;
	if (existsSync(ACTIVE_SANDBOX_FILE)) {
		const name = readFileSync(ACTIVE_SANDBOX_FILE, "utf-8").trim();
		if (name) return name;
	}
	return null;
}

function getRunningSandboxes(): string[] {
	try {
		const output = execSync("sandbox list", { encoding: "utf-8", timeout: 5000 });
		return output
			.split("\n")
			.filter((l) => l.includes("running"))
			.map((l) => l.trim().split(/\s+/)[0])
			.filter(Boolean);
	} catch {
		return [];
	}
}

function execDirect(command: string, timeout: number): Promise<{ text: string; isError: boolean }> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", command], {
			timeout,
			maxBuffer: 10 * 1024 * 1024,
			env: { ...process.env, HOME: "/root" },
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

		child.on("close", (code) => {
			const text = stdout + (stderr ? "\n" + stderr : "");
			resolve({ text: text || `(exit code: ${code})`, isError: code !== 0 });
		});

		child.on("error", (err) => {
			resolve({ text: `Error: ${err.message}`, isError: true });
		});
	});
}

function execInSandbox(sandboxName: string, command: string, timeout: number): Promise<{ text: string; isError: boolean }> {
	return new Promise((resolve) => {
		const escapedCmd = command.replace(/'/g, "'\\''");
		const fullCmd = `sandbox ${sandboxName} bash -c '${escapedCmd}'`;

		const child = spawn("bash", ["-c", fullCmd], {
			timeout,
			maxBuffer: 10 * 1024 * 1024,
			env: { ...process.env, HOME: "/root" },
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

		child.on("close", (code) => {
			const text = stdout + (stderr ? "\n" + stderr : "");
			resolve({ text: text || `(exit code: ${code})`, isError: code !== 0 });
		});

		child.on("error", (err) => {
			resolve({ text: `Error executing in sandbox "${sandboxName}": ${err.message}`, isError: true });
		});
	});
}

export default function sandboxBashExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "bash",
		label: "bash (sandbox)",
		description:
			"Execute a bash command in a shell. When an active sandbox is set, commands run inside the sandbox namespace. " +
			"All commands run with bash -c, so pipes, &&, and redirects work. " +
			"Use for terminal operations like git, npm, docker, etc. " +
			"Avoid using bash for file operations (reading, writing, editing, searching) - use the specialized tools instead.",
		promptSnippet: "Use the bash tool for terminal operations (git, npm, docker, etc.). Avoid for file operations.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The bash command to execute" },
				timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" },
				description: { type: "string", description: "Clear, concise description of what this command does (5-10 words)" },
			},
			required: ["command"],
		} as any,

		async execute(
			_toolCallId: string,
			params: { command: string; timeout?: number; description?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: any,
			_ctx: any,
		) {
			const timeout = params.timeout || 120000;
			const sandboxName = getActiveSandbox();

			let result: { text: string; isError: boolean };

			if (!sandboxName) {
				result = await execDirect(params.command, timeout);
			} else {
				result = await execInSandbox(sandboxName, params.command, timeout);
			}

			return {
				content: [{ type: "text" as const, text: result.text }],
			};
		},
	});

	pi.registerTool({
		name: "switch_sandbox",
		label: "switch_sandbox",
		description: "Switch the active sandbox for bash command execution. All subsequent bash commands will run inside the specified sandbox.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Sandbox name to switch to (e.g., 'user-zhangsan', 'pi-sandbox-box')" },
			},
			required: ["name"],
		} as any,

		async execute(
			_toolCallId: string,
			params: { name: string },
			_signal: AbortSignal | undefined,
			_onUpdate: any,
			_ctx: any,
		) {
			const running = getRunningSandboxes();
			if (!running.includes(params.name)) {
				return {
					content: [{
						type: "text" as const,
						text: `Error: Sandbox "${params.name}" is not running. Available running sandboxes: ${running.join(", ") || "none"}`,
					}],
				};
			}

			writeFileSync(ACTIVE_SANDBOX_FILE, params.name);
			return {
				content: [{
					type: "text" as const,
					text: `Switched to sandbox "${params.name}". All bash commands will now execute inside this sandbox.`,
				}],
			};
		},
	});

	pi.registerTool({
		name: "list_sandboxes",
		label: "list_sandboxes",
		description: "List all available sandboxes and their status (running/stopped).",
		parameters: {
			type: "object",
			properties: {},
		} as any,

		async execute(
			_toolCallId: string,
			_params: any,
			_signal: AbortSignal | undefined,
			_onUpdate: any,
			_ctx: any,
		) {
			try {
				const output = execSync("sandbox list", { encoding: "utf-8", timeout: 5000 });
				const active = getActiveSandbox();
				const header = active ? `Active sandbox: ${active}\n\n` : "No active sandbox set\n\n";
				return {
					content: [{ type: "text" as const, text: header + output }],
				};
			} catch (e: any) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e.message}` }],
				};
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const sandboxName = getActiveSandbox();
		if (sandboxName) {
			ctx.ui.notify(`Sandbox-Bash: Active sandbox "${sandboxName}"`, "info");
		} else {
			ctx.ui.notify("Sandbox-Bash: No active sandbox, commands run on host", "info");
		}
	});
}
