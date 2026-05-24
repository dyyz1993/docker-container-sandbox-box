/**
 * Sandbox-Box Bash Extension for pi v0.74.54
 * Overrides built-in bash to execute inside a sandbox namespace
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ACTIVE_SANDBOX_FILE = '/root/data/active-sandbox';

function getActiveSandbox() {
    if (process.env.PI_SANDBOX) return process.env.PI_SANDBOX;
    try {
        if (fs.existsSync(ACTIVE_SANDBOX_FILE)) {
            return fs.readFileSync(ACTIVE_SANDBOX_FILE, 'utf-8').trim();
        }
    } catch {}
    return null;
}

function escapeShellArg(arg) {
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

module.exports = function(pi) {
    
    // ─── Sandbox bash tool ─────────────────────────────────────────
    pi.registerTool({
        name: 'bash',
        description: 'Execute bash commands inside the active sandbox. All commands run via nsenter in the sandbox network namespace for full isolation. Use switch_sandbox first to select which sandbox to work in.',
        parameters: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The bash command to execute'
                },
                timeout: {
                    type: 'number',
                    description: 'Timeout in milliseconds (default 120000)'
                },
                description: {
                    type: 'string',
                    description: 'Brief description of what this command does'
                }
            },
            required: ['command']
        },
        
        execute(_toolCallId, { command, timeout = 120000, description }, signal, onUpdate, _ctx) {
            const sandboxName = getActiveSandbox();
            
            if (!sandboxName) {
                // No sandbox active — run on host
                return execDirect(command, timeout, signal, onUpdate);
            }
            
            return execInSandbox(sandboxName, command, timeout, signal, onUpdate);
        }
    });
    
    // ─── Switch sandbox tool ──────────────────────────────────────
    pi.registerTool({
        name: 'switch_sandbox',
        description: 'Switch the active sandbox for bash command execution. Use this when you need to work in a different sandbox for a different task or project.',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Sandbox name to switch to (e.g., "user-alice", "user-zhangsan", "pi-sandbox-box"). Use list_sandboxes to see all available sandboxes.'
                }
            },
            required: ['name']
        },
        
        execute(_toolCallId, { name }) {
            try {
                // Verify sandbox exists and running
                const output = execSync('sandbox list', { encoding: 'utf-8', timeout: 10000 });
                const lines = output.split('\n').filter(l => l.trim());
                
                const sandboxFound = lines.some(l => {
                    const parts = l.trim().split(/\s+/);
                    return parts[0] === name && l.includes('running');
                });
                
                if (!sandboxFound) {
                    const running = lines.filter(l => l.includes('running')).map(l => l.split(/\s+/)[0]);
                    return {
                        content: [{ type: 'text', text: `Error: Sandbox "${name}" is not running.\n\nRunning sandboxes:\n  ${running.join('\n  ')}` }]
                    };
                }
                
                fs.writeFileSync(ACTIVE_SANDBOX_FILE, name);
                
                return {
                    content: [{ type: 'text', text: `✓ Switched to sandbox "${name}". All bash commands will now execute inside this sandbox.` }]
                };
            } catch (e) {
                return {
                    content: [{ type: 'text', text: `Error switching sandbox: ${e.message}` }]
                };
            }
        }
    });
    
    // ─── List sandboxes tool ──────────────────────────────────────
    pi.registerTool({
        name: 'list_sandboxes',
        description: 'List all sandboxes and their current status (running/stopped). Shows name, IP, domain, and PID for each sandbox.',
        parameters: {
            type: 'object',
            properties: {}
        },
        
        execute() {
            try {
                const output = execSync('sandbox list', { encoding: 'utf-8', timeout: 10000 });
                const activeSandbox = getActiveSandbox();
                let result = output;
                if (activeSandbox) {
                    result += `\n\nActive sandbox: ${activeSandbox}`;
                }
                return {
                    content: [{ type: 'text', text: result }]
                };
            } catch (e) {
                return {
                    content: [{ type: 'text', text: `Error: ${e.message}` }]
                };
            }
        }
    });
};

// ─── Direct execution (no sandbox) ───────────────────────────────────
function execDirect(command, timeout, signal, onUpdate) {
    return new Promise((resolve) => {
        const proc = spawn('bash', ['-c', command], {
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, HOME: '/root' }
        });
        
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', (data) => {
            stdout += data.toString();
            if (onUpdate) {
                onUpdate({ content: [{ type: 'text', text: stdout }] });
            }
        });
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        if (signal) {
            signal.addEventListener('abort', () => proc.kill('SIGTERM'));
        }
        
        proc.on('close', (code) => {
            resolve({
                content: [{ type: 'text', text: stdout + (stderr ? '\n--- stderr ---\n' + stderr : '') }]
            });
        });
        
        proc.on('error', (err) => {
            resolve({
                content: [{ type: 'text', text: `Error: ${err.message}` }]
            });
        });
    });
}

// ─── Sandbox execution via nsenter ──────────────────────────────────
function execInSandbox(sandboxName, command, timeout, signal, onUpdate) {
    return new Promise((resolve) => {
        const escapedCmd = escapeShellArg(command);
        const fullCmd = `sandbox ${sandboxName} ${escapedCmd}`;
        
        const proc = spawn('bash', ['-c', fullCmd], {
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, HOME: '/root' }
        });
        
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', (data) => {
            stdout += data.toString();
            if (onUpdate) {
                onUpdate({ content: [{ type: 'text', text: stdout }] });
            }
        });
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        if (signal) {
            signal.addEventListener('abort', () => proc.kill('SIGTERM'));
        }
        
        proc.on('close', (code) => {
            resolve({
                content: [{ type: 'text', text: stdout + (stderr ? '\n--- stderr ---\n' + stderr : '') }]
            });
        });
        
        proc.on('error', (err) => {
            resolve({
                content: [{ type: 'text', text: `Error executing in sandbox "${sandboxName}": ${err.message}` }]
            });
        });
    });
}
