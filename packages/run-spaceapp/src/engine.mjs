// Container engine support: Docker (default) and rootless Podman.
//
// Every engine command is a hard-coded literal ("docker" or "podman") so the process launcher's fixed allowlist in
// cli.mjs keeps working. Podman is driven through its Docker-compatible CLI and "podman compose", so the compose
// files, project names and lifecycle commands stay the same on both engines.
import { Writable } from "node:stream";
import { PROFILE_REQUIREMENTS } from "./index.mjs";
import { UNIVERSAL_COMMAND } from "./package-info.mjs";

const GiB = 1024 ** 3;
// The memory the engine (Docker Desktop VM or podman machine) must give the containers, per profile.
const ENGINE_MEMORY_GIB = Object.freeze({ small: 3, medium: 5, large: 7, light: 3, standard: 3 });
const ENGINE_MIN_CPUS = 4;

export function engineCommand(engine) {
  return engine === "podman" ? "podman" : "docker";
}

export function engineLabel(engine) {
  return engine === "podman" ? "Podman" : "Docker";
}

export function engineReadinessProbes(engine) {
  if (engine === "podman") {
    return [
      { name: "Podman CLI", command: "podman", args: ["--version"] },
      { name: "Podman Compose", command: "podman", args: ["compose", "version"] },
      { name: "Podman Engine", command: "podman", args: ["info"] }
    ];
  }
  return [
    { name: "Docker CLI", command: "docker", args: ["--version"] },
    { name: "Docker Compose", command: "docker", args: ["compose", "version"] },
    { name: "Docker Engine", command: "docker", args: ["info"] }
  ];
}

export async function engineIsReady(execute, engine) {
  for (const { command, args } of engineReadinessProbes(engine)) {
    let code;
    try {
      code = await execute({ command, args }, { stdout: null, stderr: null });
    } catch {
      return false;
    }
    if (code !== 0) return false;
  }
  return true;
}

/**
 * The engine a fresh install should use when --engine was not given: Docker whenever Docker works, and Podman on
 * Linux/macOS when it is the only working engine, instead of installing Docker next to it.
 */
export async function detectInstallEngine({ requestedEngine, existingEngine, platform, execute }) {
  if (requestedEngine !== undefined) return { engine: requestedEngine, detected: false };
  if (existingEngine !== undefined) return { engine: existingEngine, detected: false };
  if (platform !== "linux" && platform !== "darwin") return { engine: "docker", detected: false };
  if (await engineIsReady(execute, "docker")) return { engine: "docker", detected: false };
  if (await engineIsReady(execute, "podman")) return { engine: "podman", detected: true };
  return { engine: "docker", detected: false };
}

async function captureOutput(execute, spec) {
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) {
    if (output.length < 1024 * 1024) output += chunk.toString();
    done();
  } });
  try {
    const code = await execute({ ...spec, timeoutMs: 15000 }, { stdout, stderr: null });
    return code === 0 ? output.trim() : null;
  } catch {
    return null;
  }
}

export function engineInfoProbe(engine) {
  return { command: engineCommand(engine), args: ["info", "--format", "{{json .}}"] };
}

/**
 * One shape for "docker info" and "podman info" JSON: the storage planner, doctor and support bundle read it the
 * same way on both engines.
 */
export function parseEngineInfo(engine, text) {
  let raw;
  try {
    raw = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  if (engine === "podman") {
    const host = raw.host ?? {};
    const controllers = Array.isArray(host.cgroupControllers) ? host.cgroupControllers : [];
    const cgroupVersion = typeof host.cgroupVersion === "string" ? host.cgroupVersion : null;
    const rootless = host.security?.rootless === true;
    // Rootful Podman owns the whole cgroup tree; rootless Podman can only set the limits systemd delegated to the user.
    const delegated = (name) => cgroupVersion === "v2" && (!rootless || controllers.includes(name));
    return {
      engine: "podman",
      version: raw.version?.Version ?? null,
      rootless,
      cgroupVersion,
      cpuLimitsDelegated: delegated("cpu"),
      memoryLimitsDelegated: delegated("memory"),
      cpus: Number.isFinite(host.cpus) ? host.cpus : undefined,
      memoryBytes: Number.isFinite(host.memTotal) ? host.memTotal : undefined,
      architecture: host.arch ?? "",
      rootDir: raw.store?.graphRoot ?? null
    };
  }
  const securityOptions = Array.isArray(raw.SecurityOptions) ? raw.SecurityOptions : [];
  const cgroupVersion = raw.CgroupVersion ? `v${String(raw.CgroupVersion).replace(/^v/, "")}` : null;
  return {
    engine: "docker",
    version: raw.ServerVersion ?? null,
    rootless: securityOptions.some((option) => /name=rootless/.test(option)),
    cgroupVersion,
    cpuLimitsDelegated: raw.CpuCfsQuota !== false,
    memoryLimitsDelegated: raw.MemoryLimit !== false,
    cpus: Number.isFinite(raw.NCPU) ? raw.NCPU : undefined,
    memoryBytes: Number.isFinite(raw.MemTotal) ? raw.MemTotal : undefined,
    architecture: raw.Architecture ?? "",
    rootDir: raw.DockerRootDir ?? null
  };
}

export async function inspectEngine(execute, engine) {
  return parseEngineInfo(engine, await captureOutput(execute, engineInfoProbe(engine)));
}

/** Doctor checks for the engine itself: rootless mode, cgroup v2 and delegated CPU/memory limits. */
export function engineRuntimeChecks(info) {
  if (!info || info.engine !== "podman") return [];
  const mode = info.rootless ? "rootless" : "rootful";
  const checks = [{
    name: "Podman mode",
    ok: true,
    detail: `${mode}${info.version ? `, Podman ${info.version}` : ""}`
  }];
  checks.push({
    name: "Podman cgroups",
    ok: info.cgroupVersion === "v2" || !info.rootless,
    detail: info.cgroupVersion === "v2"
      ? "cgroup v2"
      : `${info.cgroupVersion ?? "unknown cgroup version"}; rootless Podman needs cgroup v2 to apply SpaceApp's CPU and memory limits`
  });
  const delegated = info.cpuLimitsDelegated && info.memoryLimitsDelegated;
  checks.push({
    name: "Podman resource limits",
    ok: delegated,
    detail: delegated
      ? "CPU and memory limits are delegated"
      : `not delegated (cpu: ${info.cpuLimitsDelegated ? "yes" : "no"}, memory: ${info.memoryLimitsDelegated ? "yes" : "no"}). ` +
        "Delegate them to your user with a systemd drop-in: /etc/systemd/system/user@.service.d/delegate.conf containing " +
        "\"[Service]\\nDelegate=cpu cpuset io memory pids\", then run \"sudo systemctl daemon-reload\" and log in again"
  });
  return checks;
}

/** The fields the support bundle reports for the engine (never host paths or credentials). */
export function engineSupportFacts(engine, info) {
  return {
    name: engineCommand(engine),
    version: info?.version ?? null,
    mode: info ? (info.rootless ? "rootless" : "rootful") : null,
    cgroupVersion: info?.cgroupVersion ?? null,
    cpuLimitsDelegated: info ? info.cpuLimitsDelegated : null,
    memoryLimitsDelegated: info ? info.memoryLimitsDelegated : null
  };
}

/**
 * macOS runs Podman containers in a "podman machine" VM; like Docker Desktop's VM it must be large enough for the
 * profile. Reads "podman machine inspect" JSON (Resources.CPUs, Resources.Memory in MiB, Resources.DiskSize in GiB).
 */
export function podmanMachineChecks(text, profile = "small") {
  let machines;
  try {
    machines = JSON.parse(text);
  } catch {
    return { checks: [{ name: "Podman machine", ok: false, detail: "no podman machine found; run \"podman machine init\" and \"podman machine start\"" }], resize: null };
  }
  const machine = Array.isArray(machines) ? machines[0] : machines;
  const resources = machine?.Resources;
  if (!resources) {
    return { checks: [{ name: "Podman machine", ok: false, detail: "no podman machine found; run \"podman machine init\" and \"podman machine start\"" }], resize: null };
  }
  const requirements = PROFILE_REQUIREMENTS[profile];
  if (!requirements) throw new Error("Unknown installation profile.");
  const needed = {
    cpus: ENGINE_MIN_CPUS,
    memoryMiB: ENGINE_MEMORY_GIB[profile] * 1024,
    diskGiB: Math.ceil(requirements.freshDiskBytes / GiB) + 10
  };
  const cpus = Number(resources.CPUs);
  const memoryMiB = Number(resources.Memory);
  const diskGiB = Number(resources.DiskSize);
  const checks = [
    { name: "Podman machine CPU", ok: cpus >= needed.cpus, detail: `${cpus} allocated; ${needed.cpus} required` },
    { name: "Podman machine memory", ok: memoryMiB >= needed.memoryMiB,
      detail: `${(memoryMiB / 1024).toFixed(1)} GiB allocated; ${needed.memoryMiB / 1024} GiB required for ${profile}` },
    { name: "Podman machine disk", ok: diskGiB >= needed.diskGiB, detail: `${diskGiB} GiB allocated; ${needed.diskGiB} GiB required` }
  ];
  if (checks.every((check) => check.ok)) return { checks, resize: null };
  const name = typeof machine.Name === "string" && /^[A-Za-z0-9._-]+$/.test(machine.Name) ? ` ${machine.Name}` : "";
  // podman machine set cannot shrink a disk, so only growing values are ever suggested.
  const resize = [
    `podman machine stop${name}`,
    `podman machine set --cpus ${Math.max(cpus || 0, needed.cpus)} --memory ${Math.max(memoryMiB || 0, needed.memoryMiB)} --disk-size ${Math.max(diskGiB || 0, needed.diskGiB)}${name}`,
    `podman machine start${name}`
  ].join(" && ");
  return { checks, resize };
}

export function podmanInstallHelp(platform) {
  if (platform === "darwin") {
    return "Install Podman (https://podman.io), run \"podman machine init\" and \"podman machine start\", " +
      `install a compose provider (\"brew install docker-compose\" or \"pip3 install podman-compose\"), then run "${UNIVERSAL_COMMAND} install --engine podman" again.`;
  }
  return "Install Podman 4.3 or later and a compose provider (docker-compose or podman-compose) from your distribution, " +
    `check that "podman info" works as your user, then run "${UNIVERSAL_COMMAND} install --engine podman" again.`;
}

/**
 * The install/update prerequisite step for Podman. Unlike Docker, SpaceApp never installs Podman itself: it checks
 * that a working Podman with compose is present and, on macOS, that the podman machine is large enough.
 */
export async function ensurePodmanAvailable({ platform = process.platform, execute, stdout, stderr, profile = "small" }) {
  if (platform === "win32") {
    stderr.write(`Podman is supported on Linux and macOS. On Windows, install with "${UNIVERSAL_COMMAND} install --engine docker".\n`);
    return { code: 1, reexecuted: false };
  }
  if (!await engineIsReady(execute, "podman")) {
    stderr.write(`Podman is not ready: "podman --version", "podman compose version" and "podman info" must all succeed. ${podmanInstallHelp(platform)}\n`);
    return { code: 1, reexecuted: false };
  }
  if (platform === "darwin") {
    const machine = await captureOutput(execute, { command: "podman", args: ["machine", "inspect"] });
    const { checks, resize } = podmanMachineChecks(machine ?? "", profile);
    for (const check of checks) (check.ok ? stdout : stderr).write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
    if (checks.some((check) => !check.ok)) {
      if (resize) stderr.write(`Resize the podman machine for the ${profile} profile, then run "${UNIVERSAL_COMMAND} install" again:\n  ${resize}\n`);
      return { code: 1, reexecuted: false };
    }
  }
  return { code: 0, reexecuted: false };
}
