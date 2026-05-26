// src/types.ts
var UnsupportedOperationError = class extends Error {
  driver;
  operation;
  constructor(operation, driver) {
    super(`Operation "${operation}" is not supported by "${driver}" driver`);
    this.name = "UnsupportedOperationError";
    this.operation = operation;
    this.driver = driver;
  }
};
var ContainerNotFoundError = class extends Error {
  containerName;
  constructor(name) {
    super(`Container "${name}" not found`);
    this.name = "ContainerNotFoundError";
    this.containerName = name;
  }
};
var ContainerStartError = class extends Error {
  containerName;
  constructor(name, reason) {
    super(`Failed to start container "${name}": ${reason}`);
    this.name = "ContainerStartError";
    this.containerName = name;
  }
};
var ContainerNotRunningError = class extends Error {
  containerName;
  constructor(name) {
    super(`Container "${name}" is not running`);
    this.name = "ContainerNotRunningError";
    this.containerName = name;
  }
};
var AuthenticationError = class extends Error {
  constructor(reason) {
    super(`Authentication failed: ${reason}`);
    this.name = "AuthenticationError";
  }
};
var ApiRequestError = class extends Error {
  statusCode;
  endpoint;
  constructor(endpoint, statusCode, body) {
    super(`API request to "${endpoint}" failed (${statusCode}): ${body}`);
    this.name = "ApiRequestError";
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
};

// src/container.ts
var DEFAULT_WAIT_ATTEMPTS = 60;
var WAIT_INTERVAL_MS = 1e3;
var Container = class {
  name;
  config;
  driver;
  constructor(name, config, driver) {
    this.name = name;
    this.config = config;
    this.driver = driver;
  }
  async start(options) {
    const merged = { ...this.config, ...options };
    await this.driver.start(this.name, merged);
  }
  async startAndWaitForPorts(options) {
    await this.start(options);
    const ports = this.config.requiredPorts;
    if (!ports || ports.length === 0) {
      for (let i = 0; i < DEFAULT_WAIT_ATTEMPTS; i++) {
        const state = await this.driver.getState(this.name);
        if (state.status === "running" || state.status === "healthy") return;
        await new Promise((r) => setTimeout(r, WAIT_INTERVAL_MS));
      }
      throw new Error(`Container "${this.name}" failed to start within ${DEFAULT_WAIT_ATTEMPTS}s`);
    }
    for (const port of ports) {
      for (let i = 0; i < DEFAULT_WAIT_ATTEMPTS; i++) {
        try {
          const probe = new Request(`http://localhost:${port}/`);
          const resp = await this.driver.fetch(this.name, probe, port);
          if (resp.ok || resp.status < 500) break;
        } catch {
        }
        if (i === DEFAULT_WAIT_ATTEMPTS - 1) {
          throw new Error(`Container "${this.name}" port ${port} not ready within ${DEFAULT_WAIT_ATTEMPTS}s`);
        }
        await new Promise((r) => setTimeout(r, WAIT_INTERVAL_MS));
      }
    }
  }
  async stop(signal) {
    await this.driver.stop(this.name, signal);
  }
  async destroy() {
    await this.driver.destroy(this.name);
  }
  async fetch(request) {
    return this.driver.fetch(this.name, request, this.config.defaultPort);
  }
  async getState() {
    return this.driver.getState(this.name);
  }
  async exec(command) {
    return this.driver.exec(this.name, command);
  }
  async execStream(command, callbacks, options) {
    return this.driver.execStream(this.name, command, callbacks, options);
  }
  async readFile(path) {
    return this.driver.readFile(this.name, path);
  }
  async writeFile(path, content) {
    return this.driver.writeFile(this.name, path, content);
  }
  async listFiles(path = "/") {
    return this.driver.listFiles(this.name, path);
  }
  async gitStatus() {
    return this.driver.gitStatus(this.name);
  }
  async gitPush(message) {
    return this.driver.gitPush(this.name, message);
  }
  async getStats() {
    return this.driver.getStats(this.name);
  }
};

// src/drivers/sandbox-box.ts
import { spawn } from "child_process";
function mapStatus(raw) {
  switch (raw) {
    case "running":
      return "running";
    case "creating":
      return "creating";
    case "stopping":
      return "stopping";
    case "error":
      return "error";
    default:
      return "stopped";
  }
}
var SandboxBoxDriver = class {
  type = "sandbox-box";
  baseUrl;
  password;
  token;
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.password = config.password ?? "";
    this.token = config.token ?? "";
  }
  async ensureToken() {
    if (this.token) return this.token;
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: this.password })
    });
    if (!res.ok) {
      throw new AuthenticationError(`Login returned ${res.status}`);
    }
    const data = await res.json();
    if (!data.token) {
      throw new AuthenticationError("No token in login response");
    }
    this.token = data.token;
    return this.token;
  }
  async rawRequest(path, options = {}) {
    const token = await this.ensureToken();
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Content-Type") && options.body) {
      headers.set("Content-Type", "application/json");
    }
    return fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers
    });
  }
  async request(path, options = {}) {
    const res = await this.rawRequest(path, options);
    if (res.status === 401) {
      this.token = "";
      const retry = await this.rawRequest(path, options);
      if (!retry.ok) {
        throw new ApiRequestError(path, retry.status, await retry.text());
      }
      return retry;
    }
    if (!res.ok) {
      throw new ApiRequestError(path, res.status, await res.text());
    }
    return res;
  }
  // --- Lifecycle ---
  async create(name, config) {
    if (config?.repoUrl) {
      await this.request("/api/sandboxes/clone", {
        method: "POST",
        body: JSON.stringify({
          name,
          repoUrl: config.repoUrl,
          branch: config.branch
        })
      });
    } else {
      await this.request("/api/sandboxes", {
        method: "POST",
        body: JSON.stringify({ name })
      });
    }
  }
  async start(name, config) {
    const state = await this.getState(name);
    if (state.status === "running" || state.status === "healthy") {
      return;
    }
    await this.create(name, config);
  }
  async stop(name, _signal) {
    try {
      await this.request(`/api/sandboxes/${encodeURIComponent(name)}/exec`, {
        method: "POST",
        body: JSON.stringify({ command: "echo stopping" })
      });
    } catch {
    }
  }
  async destroy(name) {
    const res = await this.rawRequest(
      `/api/sandboxes/${encodeURIComponent(name)}`,
      { method: "DELETE" }
    );
    if (!res.ok && res.status !== 404) {
      throw new ApiRequestError(`/api/sandboxes/${name}`, res.status, await res.text());
    }
  }
  async getState(name) {
    const res = await this.request("/api/sandboxes");
    const data = await res.json();
    const sb = data.sandboxes.find((s) => s.name === name);
    if (!sb) {
      return {
        status: "stopped",
        lastChange: /* @__PURE__ */ new Date()
      };
    }
    return {
      status: mapStatus(sb.status),
      lastChange: new Date(sb.updatedAt ?? sb.createdAt),
      pid: sb.pid,
      ip: sb.ip,
      domain: sb.domain,
      port: sb.port
    };
  }
  // --- Networking ---
  async fetch(name, request, port) {
    const state = await this.getState(name);
    if (state.status !== "running" && state.status !== "healthy") {
      throw new ContainerNotFoundError(name);
    }
    const targetPort = port ?? 3100;
    const url = new URL(request.url);
    const targetUrl = `http://${state.ip}:${targetPort}${url.pathname}${url.search}`;
    return fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? void 0 : request.body
    });
  }
  // --- Exec ---
  async exec(name, command) {
    const res = await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/exec`,
      {
        method: "POST",
        body: JSON.stringify({ command })
      }
    );
    const data = await res.json();
    return {
      stdout: data.stdout ?? data.output ?? "",
      stderr: data.stderr ?? "",
      exitCode: data.exitCode ?? 0
    };
  }
  async execStream(name, command, callbacks, options) {
    return new Promise((resolve, reject) => {
      const escaped = command.replace(/'/g, "'\\''");
      const proc = spawn("bash", ["-c", `sandbox ${name} '${escaped}'`], {
        timeout: options?.timeout,
        env: { ...process.env, HOME: "/root" },
        cwd: options?.cwd
      });
      proc.stdout.on("data", (data) => callbacks.onStdout(data.toString()));
      proc.stderr.on("data", (data) => callbacks.onStderr?.(data.toString()));
      if (options?.signal) {
        const onAbort = () => proc.kill("SIGTERM");
        options.signal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => options.signal.removeEventListener("abort", onAbort));
      }
      proc.on("close", (code) => resolve({ exitCode: code ?? 0 }));
      proc.on("error", (err) => reject(err));
    });
  }
  // --- Files ---
  async readFile(name, path) {
    const res = await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/files/read?path=${encodeURIComponent(path)}`
    );
    return await res.text();
  }
  async writeFile(name, path, content) {
    await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/files/write`,
      {
        method: "PUT",
        body: JSON.stringify({ path, content })
      }
    );
  }
  async listFiles(name, path) {
    const res = await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`
    );
    const data = await res.json();
    return data.map((f) => ({
      name: f.name,
      path: `${path}/${f.name}`,
      type: f.type ?? "file",
      size: f.size ?? 0,
      modified: f.mtime ?? ""
    }));
  }
  // --- Git ---
  async gitStatus(name) {
    const res = await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/git/status`
    );
    return await res.json();
  }
  async gitPush(name, message) {
    await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/git/push`,
      {
        method: "POST",
        body: JSON.stringify({ message })
      }
    );
  }
  // --- Stats ---
  async getStats(name) {
    const res = await this.request(
      `/api/sandboxes/${encodeURIComponent(name)}/stats`
    );
    return await res.json();
  }
  // --- List ---
  async list() {
    const res = await this.request("/api/sandboxes");
    const data = await res.json();
    return data.sandboxes.map((sb) => ({
      name: sb.name,
      state: {
        status: mapStatus(sb.status),
        lastChange: new Date(sb.updatedAt ?? sb.createdAt),
        pid: sb.pid,
        ip: sb.ip,
        domain: sb.domain,
        port: sb.port
      }
    }));
  }
};

// src/drivers/cloudflare.ts
var CloudflareDriver = class {
  type = "cloudflare";
  binding;
  constructor(config) {
    this.binding = config.binding;
  }
  async create(_name, _config) {
    throw new UnsupportedOperationError("create", "cloudflare");
  }
  async start(name, config) {
    const cf = this.binding;
    if (!cf || typeof cf.start !== "function") {
      throw new UnsupportedOperationError("start", "cloudflare");
    }
    await cf.start(name, config);
  }
  async stop(name, signal) {
    const cf = this.binding;
    if (!cf || typeof cf.stop !== "function") {
      throw new UnsupportedOperationError("stop", "cloudflare");
    }
    await cf.stop(name, signal);
  }
  async destroy(name) {
    const cf = this.binding;
    if (!cf || typeof cf.destroy !== "function") {
      throw new UnsupportedOperationError("destroy", "cloudflare");
    }
    await cf.destroy(name);
  }
  async getState(name) {
    const cf = this.binding;
    if (!cf || typeof cf.getState !== "function") {
      throw new UnsupportedOperationError("getState", "cloudflare");
    }
    return cf.getState(name);
  }
  async fetch(name, request, port) {
    const cf = this.binding;
    if (!cf || typeof cf.fetch !== "function") {
      throw new UnsupportedOperationError("fetch", "cloudflare");
    }
    return cf.fetch(name, request, port);
  }
  async exec(_name, _command) {
    throw new UnsupportedOperationError("exec", "cloudflare");
  }
  async execStream(_name, _command, _callbacks, _options) {
    throw new UnsupportedOperationError("execStream", "cloudflare");
  }
  async readFile(_name, _path) {
    throw new UnsupportedOperationError("readFile", "cloudflare");
  }
  async writeFile(_name, _path, _content) {
    throw new UnsupportedOperationError("writeFile", "cloudflare");
  }
  async listFiles(_name, _path) {
    throw new UnsupportedOperationError("listFiles", "cloudflare");
  }
  async gitStatus(_name) {
    throw new UnsupportedOperationError("gitStatus", "cloudflare");
  }
  async gitPush(_name, _message) {
    throw new UnsupportedOperationError("gitPush", "cloudflare");
  }
  async getStats(_name) {
    throw new UnsupportedOperationError("getStats", "cloudflare");
  }
  async list() {
    throw new UnsupportedOperationError("list", "cloudflare");
  }
};

// src/drivers/docker.ts
import { spawn as spawn2 } from "child_process";
import { createConnection } from "net";
var LABEL_MANAGED = "sandbox-box.managed";
var LABEL_NAME = "sandbox-box.name";
var WORKSPACE_DIR = "/workspace";
var DockerDriver = class {
  type = "docker";
  socketPath;
  image;
  defaultPort;
  constructor(opts = {}) {
    this.socketPath = opts.socketPath ?? "/var/run/docker.sock";
    this.image = opts.image ?? "node:22-bookworm-slim";
    this.defaultPort = opts.defaultPort ?? 3e3;
  }
  async dockerRequest(path, options = {}) {
    const { method = "GET", body, headers = {}, hijack = false, timeout: reqTimeout = 6e4 } = options;
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath, () => {
        const reqHeaders = {
          Host: "localhost",
          ...headers
        };
        if (hijack) {
          reqHeaders["Connection"] = "Upgrade";
          reqHeaders["Upgrade"] = "tcp";
        }
        let raw = `${method} ${path} HTTP/1.1\r
`;
        for (const [k, v] of Object.entries(reqHeaders)) {
          raw += `${k}: ${v}\r
`;
        }
        if (body) {
          const buf = Buffer.from(body);
          reqHeaders["Content-Type"] = reqHeaders["Content-Type"] ?? "application/json";
          raw += `Content-Type: ${reqHeaders["Content-Type"]}\r
Content-Length: ${buf.length}\r
\r
`;
          socket.write(raw);
          socket.write(buf);
        } else {
          raw += "\r\n";
          socket.write(raw);
        }
        if (hijack) {
          resolve({ status: 101, body: "", socket });
          return;
        }
        let data = Buffer.alloc(0);
        let headersDone = false;
        let statusCode = 0;
        let contentLength = -1;
        let isChunked = false;
        let bodyStart = 0;
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            socket.destroy();
            reject(new Error(`Docker API request timed out (${reqTimeout}ms): ${method} ${path}`));
          }
        }, reqTimeout);
        socket.on("data", (chunk) => {
          data = Buffer.concat([data, chunk]);
          if (!headersDone) {
            const headerEnd = data.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;
            headersDone = true;
            bodyStart = headerEnd + 4;
            const headerStr = data.slice(0, headerEnd).toString();
            const statusMatch = headerStr.match(/^HTTP\/\d\.\d\s+(\d+)/);
            if (statusMatch) statusCode = parseInt(statusMatch[1], 10);
            const clMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
            if (clMatch) contentLength = parseInt(clMatch[1], 10);
            if (headerStr.match(/Transfer-Encoding:\s*chunked/i)) {
              isChunked = true;
            }
            if (!isChunked && contentLength < 0 && data.length === bodyStart) {
              clearTimeout(timeout);
              settled = true;
              socket.destroy();
              resolve({ status: statusCode, body: "" });
              return;
            }
          }
          if (isChunked) {
            const term = data.indexOf(Buffer.from("0\r\n\r\n"));
            if (term !== -1) {
              const bodyData = data.slice(bodyStart, term);
              const decoded = this.decodeChunked(bodyData.toString());
              clearTimeout(timeout);
              settled = true;
              socket.destroy();
              resolve({ status: statusCode, body: decoded });
            }
          } else if (contentLength >= 0) {
            const received = data.length - bodyStart;
            if (received >= contentLength) {
              const bodyData = data.slice(bodyStart, bodyStart + contentLength);
              clearTimeout(timeout);
              settled = true;
              socket.destroy();
              resolve({ status: statusCode, body: bodyData.toString() });
            }
          }
        });
        socket.on("error", (err) => {
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
        socket.on("close", () => {
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            if (headersDone) {
              const bodyData = data.slice(bodyStart).toString();
              resolve({ status: statusCode, body: bodyData });
            } else {
              reject(new Error("Socket closed before response headers"));
            }
          }
        });
      });
      socket.on("error", reject);
    });
  }
  decodeChunked(raw) {
    const parts = [];
    let offset = 0;
    while (offset < raw.length) {
      const lineEnd = raw.indexOf("\r\n", offset);
      if (lineEnd === -1) break;
      const size = parseInt(raw.slice(offset, lineEnd), 16);
      if (size === 0) break;
      offset = lineEnd + 2;
      parts.push(raw.slice(offset, offset + size));
      offset += size + 2;
    }
    return parts.join("");
  }
  findContainerByName(name) {
    return this.listAllContainers().then((containers) => {
      const match = containers.find(
        (c) => c.Config?.Labels?.[LABEL_NAME] === name || c.Name === `/${name}`
      );
      return match ?? null;
    });
  }
  async listAllContainers() {
    try {
      const { body, status } = await this.dockerRequest(
        `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [`${LABEL_MANAGED}=true`] }))}`
      );
      if (status >= 400) return [];
      const list = JSON.parse(body);
      const results = [];
      for (const c of list) {
        try {
          const { body: inspectBody, status: inspectStatus } = await this.dockerRequest(
            `/containers/${c.Id}/json`
          );
          if (inspectStatus < 400) {
            results.push(JSON.parse(inspectBody));
          }
        } catch {
        }
      }
      return results;
    } catch {
      return [];
    }
  }
  containerName(name) {
    return name;
  }
  async create(name, config) {
    const existing = await this.findContainerByName(name);
    if (existing) return;
    const env = [];
    if (config?.envVars) {
      for (const [k, v] of Object.entries(config.envVars)) {
        env.push(`${k}=${v}`);
      }
    }
    const entrypoint = config?.entrypoint ?? ["sleep", "infinity"];
    const exposedPorts = {};
    const portBindings = {};
    const port = config?.defaultPort ?? this.defaultPort;
    if (port) {
      exposedPorts[`${port}/tcp`] = {};
    }
    const body = JSON.stringify({
      Image: this.image,
      name: this.containerName(name),
      Labels: {
        [LABEL_MANAGED]: "true",
        [LABEL_NAME]: name
      },
      WorkingDir: WORKSPACE_DIR,
      Env: env,
      Entrypoint: entrypoint,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        AutoRemove: false
      },
      Tty: true,
      OpenStdin: true
    });
    const { status, body: respBody } = await this.dockerRequest("/containers/create", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
      timeout: 12e4
    });
    if (status >= 400) {
      throw new ContainerStartError(name, respBody);
    }
    if (config?.repoUrl) {
      await this.start(name);
      try {
        const branch = config.branch ? ` -b ${config.branch}` : "";
        await this.exec(name, `mkdir -p ${WORKSPACE_DIR} && cd ${WORKSPACE_DIR} && git clone${branch} ${config.repoUrl} . || true`);
      } catch {
      }
      await this.stop(name);
    }
  }
  async start(name, config) {
    let container = await this.findContainerByName(name);
    if (!container) {
      await this.create(name, config);
      container = await this.findContainerByName(name);
    }
    if (!container) {
      throw new ContainerStartError(name, "Failed to create container");
    }
    if (container.State.Running) return;
    const { status, body } = await this.dockerRequest(
      `/containers/${container.Id}/start`,
      { method: "POST", timeout: 12e4 }
    );
    if (status >= 400 && status !== 304) {
      throw new ContainerStartError(name, body);
    }
  }
  async stop(name, signal) {
    const container = await this.findContainerByName(name);
    if (!container || !container.State.Running) return;
    const sig = typeof signal === "number" ? signal : signal ?? "SIGTERM";
    await this.dockerRequest(
      `/containers/${container.Id}/stop?signal=${encodeURIComponent(String(sig))}`,
      { method: "POST" }
    );
  }
  async destroy(name) {
    const container = await this.findContainerByName(name);
    if (!container) return;
    if (container.State.Running) {
      await this.dockerRequest(`/containers/${container.Id}/stop?t=5`, {
        method: "POST"
      });
    }
    await this.dockerRequest(`/containers/${container.Id}?v=true&force=true`, {
      method: "DELETE"
    });
  }
  async getState(name) {
    const container = await this.findContainerByName(name);
    if (!container) {
      return { status: "stopped", lastChange: /* @__PURE__ */ new Date() };
    }
    const statusMap = {
      running: "running",
      created: "stopped",
      exited: "stopped_with_code",
      dead: "error",
      paused: "stopped",
      restarting: "creating",
      removing: "stopping"
    };
    const ip = this.getContainerIP(container);
    const port = this.defaultPort;
    return {
      status: statusMap[container.State.Status] ?? "stopped",
      lastChange: new Date(
        container.State.StartedAt ?? container.State.FinishedAt ?? /* @__PURE__ */ new Date()
      ),
      exitCode: container.State.ExitCode,
      pid: container.State.Pid > 0 ? container.State.Pid : void 0,
      ip: ip || void 0,
      port,
      domain: name
    };
  }
  getContainerIP(container) {
    const networks = container.NetworkSettings?.Networks ?? {};
    for (const net of Object.values(networks)) {
      if (net.IPAddress) return net.IPAddress;
    }
    return "";
  }
  async fetch(name, request, port) {
    const state = await this.getState(name);
    if (state.status !== "running" && state.status !== "healthy") {
      throw new ContainerNotRunningError(name);
    }
    const targetPort = port ?? this.defaultPort;
    const target = state.ip ?? name;
    const url = new URL(request.url);
    const targetUrl = `http://${target}:${targetPort}${url.pathname}${url.search}`;
    return fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? void 0 : request.body
    });
  }
  async exec(name, command) {
    const container = await this.findContainerByName(name);
    if (!container) throw new ContainerNotFoundError(name);
    if (!container.State.Running) throw new ContainerNotRunningError(name);
    const { body: createBody, status: createStatus } = await this.dockerRequest(
      `/containers/${container.Id}/exec`,
      {
        method: "POST",
        body: JSON.stringify({
          AttachStdout: true,
          AttachStderr: true,
          Cmd: ["bash", "-c", command]
        })
      }
    );
    if (createStatus >= 400) {
      return { stdout: "", stderr: createBody, exitCode: 1 };
    }
    const execId = JSON.parse(createBody).Id;
    const { body: startBody, status: startStatus } = await this.dockerRequest(
      `/exec/${execId}/start`,
      {
        method: "POST",
        body: JSON.stringify({ Detach: false, Tty: false }),
        headers: { "Content-Type": "application/json" }
      }
    );
    let stdout = "";
    let stderr = "";
    if (startStatus < 400 && startBody) {
      const parsed = this.parseDockerStream(startBody);
      stdout = parsed.stdout;
      stderr = parsed.stderr;
    }
    const { body: inspectBody } = await this.dockerRequest(`/exec/${execId}/json`);
    const execInspect = JSON.parse(inspectBody);
    return {
      stdout,
      stderr,
      exitCode: execInspect.ExitCode ?? 1
    };
  }
  parseDockerStream(raw) {
    const stdoutParts = [];
    const stderrParts = [];
    let offset = 0;
    const buf = Buffer.from(raw, "binary");
    while (offset + 8 <= buf.length) {
      const streamType = buf[offset];
      offset += 4;
      const length = buf.readUInt32BE(offset);
      offset += 4;
      if (offset + length > buf.length) break;
      const data = buf.slice(offset, offset + length).toString("utf-8");
      offset += length;
      if (streamType === 1) {
        stdoutParts.push(data);
      } else if (streamType === 2) {
        stderrParts.push(data);
      }
    }
    return {
      stdout: stdoutParts.join(""),
      stderr: stderrParts.join("")
    };
  }
  async execStream(name, command, callbacks, options) {
    const container = await this.findContainerByName(name);
    if (!container) throw new ContainerNotFoundError(name);
    if (!container.State.Running) throw new ContainerNotRunningError(name);
    return new Promise((resolve, reject) => {
      const proc = spawn2("docker", ["exec", name, "bash", "-c", command], {
        timeout: options?.timeout,
        cwd: options?.cwd
      });
      proc.stdout.on("data", (data) => callbacks.onStdout(data.toString()));
      proc.stderr.on("data", (data) => callbacks.onStderr?.(data.toString()));
      if (options?.signal) {
        const onAbort = () => proc.kill("SIGTERM");
        options.signal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => options.signal.removeEventListener("abort", onAbort));
      }
      proc.on("close", (code) => resolve({ exitCode: code ?? 0 }));
      proc.on("error", (err) => reject(err));
    });
  }
  async readFile(name, path) {
    const { stdout } = await this.exec(name, `cat ${path}`);
    return stdout;
  }
  async writeFile(name, path, content) {
    const escaped = content.replace(/'/g, "'\\''");
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      await this.exec(name, `mkdir -p ${dir}`);
    }
    await this.exec(name, `printf '%s' '${escaped}' > ${path}`);
  }
  async listFiles(name, path) {
    const { stdout, exitCode } = await this.exec(
      name,
      `ls -1 --time-style=full-iso ${path} 2>/dev/null | tail -n +1`
    );
    if (exitCode !== 0) return [];
    const { stdout: statOutput } = await this.exec(
      name,
      `stat -c '%F	%s	%Y' ${path}/* 2>/dev/null || true`
    );
    const fileMap = /* @__PURE__ */ new Map();
    for (const line of statOutput.split("\n")) {
      if (!line.trim()) continue;
      const [fullPath, type, size, mtime] = line.split("	");
      const fileName = fullPath.split("/").pop() ?? "";
      fileMap.set(fileName, {
        type,
        size: parseInt(size, 10) || 0,
        modified: parseInt(mtime, 10) * 1e3 || Date.now()
      });
    }
    return stdout.split("\n").filter((l) => l.trim()).map((line) => {
      const fileName = line.trim();
      const info = fileMap.get(fileName) ?? {
        type: "regular file",
        size: 0,
        modified: Date.now()
      };
      const type = info.type.includes("directory") ? "directory" : info.type.includes("link") ? "symlink" : "file";
      return {
        name: fileName,
        path: `${path}/${fileName}`.replace(/\/+/g, "/"),
        type,
        size: info.size,
        modified: new Date(info.modified).toISOString()
      };
    });
  }
  async gitStatus(name) {
    const { stdout } = await this.exec(
      name,
      `cd ${WORKSPACE_DIR} 2>/dev/null && git status --porcelain=v2 --branch 2>/dev/null || echo "NOT_A_REPO"`
    );
    if (stdout.includes("NOT_A_REPO")) {
      return {
        branch: "",
        modified: [],
        staged: [],
        untracked: [],
        ahead: 0,
        behind: 0,
        recentCommits: []
      };
    }
    const branch = this.extractBranch(stdout);
    const modified = [];
    const staged = [];
    const untracked = [];
    let ahead = 0;
    let behind = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("# branch.ab")) {
        const parts = line.split(" ");
        for (const p of parts) {
          if (p.startsWith("+")) ahead = parseInt(p.slice(1), 10);
          if (p.startsWith("-")) behind = Math.abs(parseInt(p.slice(1), 10));
        }
      } else if (line.startsWith("1 M") || line.startsWith("1 .M")) {
        modified.push(line.split(/\s+/).slice(-1)[0]);
      } else if (line.startsWith("1 M.") || line.startsWith("1 A.") || line.startsWith("1 C.")) {
        staged.push(line.split(/\s+/).slice(-1)[0]);
      } else if (line.startsWith("? ")) {
        untracked.push(line.slice(2).trim());
      }
    }
    const { stdout: logOutput } = await this.exec(
      name,
      `cd ${WORKSPACE_DIR} && git log --oneline -5 --format='%h|%s|%an|%ci' 2>/dev/null || true`
    );
    const recentCommits = logOutput.split("\n").filter((l) => l.trim()).map((line) => {
      const [hash, message, author, date] = line.split("|");
      return { hash, message, author, date };
    });
    return { branch, modified, staged, untracked, ahead, behind, recentCommits };
  }
  extractBranch(porcelainOutput) {
    for (const line of porcelainOutput.split("\n")) {
      if (line.startsWith("# branch.head")) {
        return line.split(" ").slice(-1)[0] || "HEAD";
      }
    }
    return "HEAD";
  }
  async gitPush(name, message) {
    const escapedMsg = message.replace(/"/g, '\\"');
    await this.exec(
      name,
      `cd ${WORKSPACE_DIR} && git add -A && git commit -m "${escapedMsg}" && git push`
    );
  }
  async getStats(name) {
    const container = await this.findContainerByName(name);
    if (!container) throw new ContainerNotFoundError(name);
    const { body } = await this.dockerRequest(
      `/containers/${container.Id}/stats?stream=false`
    );
    const stats = JSON.parse(body);
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPercent = sysDelta > 0 ? cpuDelta / sysDelta * stats.cpu_stats.online_cpus * 100 : 0;
    return {
      cpu: Math.round(cpuPercent * 100) / 100,
      memory: stats.memory_stats.usage,
      memoryLimit: stats.memory_stats.limit,
      processes: stats.num_procs ?? 0,
      disk: 0
    };
  }
  async list() {
    const containers = await this.listAllContainers();
    return containers.map((c) => {
      const name = c.Config?.Labels?.[LABEL_NAME] ?? c.Name.replace(/^\//, "");
      return {
        name,
        state: {
          status: c.State.Running ? "running" : "stopped",
          lastChange: new Date(
            c.State.StartedAt ?? c.State.FinishedAt ?? /* @__PURE__ */ new Date()
          ),
          pid: c.State.Pid > 0 ? c.State.Pid : void 0,
          ip: this.getContainerIP(c) || void 0,
          port: this.defaultPort
        }
      };
    });
  }
};

// src/index.ts
var _driver = null;
function initDriver(config) {
  if (config.type === "sandbox-box") {
    _driver = new SandboxBoxDriver({
      baseUrl: config.baseUrl,
      token: config.token,
      password: config.password
    });
    return;
  }
  if (config.type === "cloudflare") {
    _driver = new CloudflareDriver({ binding: config.binding });
    return;
  }
  if (config.type === "docker") {
    _driver = new DockerDriver({
      socketPath: config.socketPath,
      image: config.image,
      defaultPort: config.defaultPort
    });
    return;
  }
  throw new Error(`Unknown driver type: ${config.type}`);
}
function getDriver() {
  if (_driver) return _driver;
  const driverType = typeof process !== "undefined" && process.env?.CONTAINER_DRIVER || "sandbox-box";
  if (driverType === "sandbox-box") {
    _driver = new SandboxBoxDriver({
      baseUrl: typeof process !== "undefined" && process.env?.SANDBOX_BOX_URL || "http://localhost:9091",
      password: typeof process !== "undefined" && process.env?.SANDBOX_BOX_PASSWORD || "sandbox2024"
    });
    return _driver;
  }
  if (driverType === "docker") {
    _driver = new DockerDriver({
      socketPath: typeof process !== "undefined" && process.env?.DOCKER_SOCKET || "/var/run/docker.sock",
      image: typeof process !== "undefined" && process.env?.DOCKER_IMAGE || "node:22-bookworm-slim"
    });
    return _driver;
  }
  throw new Error(
    'Cloudflare driver must be initialized explicitly with initDriver({ type: "cloudflare", binding })'
  );
}
function resetDriver() {
  _driver = null;
}
function getContainer(name, config) {
  const driver = getDriver();
  return new Container(name, config ?? {}, driver);
}
async function listContainers() {
  const driver = getDriver();
  const items = await driver.list();
  return items.map((item) => new Container(item.name, {}, driver));
}
function switchPort(request, port) {
  const url = new URL(request.url);
  const newUrl = new URL(url.pathname + url.search + url.hash, url.origin);
  const headers = new Headers(request.headers);
  headers.set("X-Container-Port", String(port));
  return new Request(newUrl, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? void 0 : request.body,
    redirect: request.redirect
  });
}
export {
  ApiRequestError,
  AuthenticationError,
  CloudflareDriver,
  Container,
  ContainerNotFoundError,
  ContainerNotRunningError,
  ContainerStartError,
  DockerDriver,
  SandboxBoxDriver,
  UnsupportedOperationError,
  getContainer,
  getDriver,
  initDriver,
  listContainers,
  resetDriver,
  switchPort
};
//# sourceMappingURL=index.mjs.map