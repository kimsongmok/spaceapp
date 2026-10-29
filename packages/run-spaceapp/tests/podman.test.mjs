import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import {
  composeCommand,
  createDefaultConfig,
  renderWorkspaceCompose,
  resolveInstallEngine,
  validateConfig,
  initializeInstallation
} from "../src/index.mjs";
import {
  engineCommand,
  engineIsReady,
  engineReadinessProbes,
  engineRuntimeChecks,
  engineSupportFacts,
  inspectEngine,
  parseEngineInfo,
  podmanMachineChecks
} from "../src/engine.mjs";
import { run } from "../src/cli.mjs";

function capture() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    }
  });
  return { stream, value: () => value };
}

function ttyStdin(...answers) {
  let index = 0;
  return {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= answers.length) return { done: true };
          const answer = answers[index++];
          return { done: false, value: `${answer}\n` };
        },
        async return() {
          return { done: true };
        }
      };
    }
  };
}

test("resolveInstallEngine validates engine choices and rejects invalid values", () => {
  assert.equal(resolveInstallEngine(undefined), "docker");
  assert.equal(resolveInstallEngine("docker"), "docker");
  assert.equal(resolveInstallEngine("podman"), "podman");
  assert.throws(() => resolveInstallEngine("kubernetes"), /Install engine must be docker or podman/);
});

test("resolveInstallEngine refuses switching engines on existing installation", () => {
  assert.throws(
    () => resolveInstallEngine("podman", { existingEngine: "docker" }),
    /switching it to podman in place would leave its data behind/
  );
  assert.throws(
    () => resolveInstallEngine("docker", { existingEngine: "podman" }),
    /switching it to docker in place would leave its data behind/
  );
  assert.equal(resolveInstallEngine("podman", { existingEngine: "podman" }), "podman");
  assert.equal(resolveInstallEngine("docker", { existingEngine: "docker" }), "docker");
});

test("resolveInstallEngine refuses host-root access mode with Podman engine", () => {
  assert.throws(
    () => resolveInstallEngine("podman", { accessMode: "host-root" }),
    /Host-root access is not supported on Podman/
  );
  assert.equal(resolveInstallEngine("docker", { accessMode: "host-root" }), "docker");
});

test("composeCommand dispatches podman when engine is podman", () => {
  const root = join(tmpdir(), "spaceapp-test-podman-compose");
  const dockerCmd = composeCommand("up", root, { engine: "docker" });
  assert.equal(dockerCmd.command, "docker");
  assert.deepEqual(dockerCmd.args.slice(0, 5), ["compose", "--project-name", dockerCmd.args[2], "--project-directory", root]);

  const podmanCmd = composeCommand("up", root, { engine: "podman" });
  assert.equal(podmanCmd.command, "podman");
  assert.deepEqual(podmanCmd.args.slice(0, 5), ["compose", "--project-name", podmanCmd.args[2], "--project-directory", root]);
});

test("renderWorkspaceCompose includes SELinux relabeling and keep-id for Podman workspaces", async () => {
  const base = createDefaultConfig({ version: "1.1.9" });
  const { addWorkspace } = await import("../src/index.mjs");
  const config = await addWorkspace({ ...base, engine: "podman" }, tmpdir());
  const composeYml = renderWorkspaceCompose(config, { selinuxRelabel: true });
  assert.match(composeYml, /selinux: z/);
  assert.match(composeYml, /userns_mode: "keep-id:uid=10001,gid=10001"/);
});

test("parseEngineInfo parses podman info cgroups and rootless facts", () => {
  const samplePodmanInfo = JSON.stringify({
    host: {
      arch: "amd64",
      cpus: 8,
      memTotal: 16 * 1024 ** 3,
      cgroupVersion: "v2",
      cgroupControllers: ["cpu", "memory", "pids"],
      security: { rootless: true }
    },
    version: { Version: "5.0.2" },
    store: { graphRoot: "/home/user/.local/share/containers/storage" }
  });

  const parsed = parseEngineInfo("podman", samplePodmanInfo);
  assert.equal(parsed.engine, "podman");
  assert.equal(parsed.version, "5.0.2");
  assert.equal(parsed.rootless, true);
  assert.equal(parsed.cgroupVersion, "v2");
  assert.equal(parsed.cpuLimitsDelegated, true);
  assert.equal(parsed.memoryLimitsDelegated, true);

  const checks = engineRuntimeChecks(parsed);
  assert.ok(checks.every((c) => c.ok));
  assert.equal(checks[0].detail, "rootless, Podman 5.0.2");
});

test("podmanMachineChecks validates macOS podman machine resources and generates resize instructions", () => {
  const undersizedMachine = JSON.stringify([{
    Name: "podman-machine-default",
    Resources: { CPUs: 2, Memory: 2048, DiskSize: 20 }
  }]);

  const { checks, resize } = podmanMachineChecks(undersizedMachine, "small");
  assert.ok(checks.some((c) => !c.ok));
  assert.match(resize, /podman machine stop podman-machine-default/);
  assert.match(resize, /podman machine set --cpus 4 --memory 3072/);
  assert.match(resize, /podman machine start podman-machine-default/);

  const adequateMachine = JSON.stringify([{
    Name: "podman-machine-default",
    Resources: { CPUs: 6, Memory: 8192, DiskSize: 60 }
  }]);

  const adequateResult = podmanMachineChecks(adequateMachine, "small");
  assert.ok(adequateResult.checks.every((c) => c.ok));
  assert.equal(adequateResult.resize, null);
});

test("install with --engine podman persists engine in config and calls podman prerequisite", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-install-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];

  const exitCode = await run(["install", "--engine", "podman", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin("1", "1", "n", "n", "n", "y"),
    inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 40 * 1024 ** 3 }),
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    },
    request: async (url) => url.endsWith("/readyz")
      ? { ok: true, json: async () => ({ ok: true }) }
      : { ok: true, json: async () => ({ setupRequired: false, expiresAt: null }) }
  });

  if (exitCode !== 0) {
    console.error("STDERR:", stderr.value());
    console.log("STDOUT:", stdout.value());
  }
  assert.equal(exitCode, 0);
  const savedConfig = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(savedConfig.engine, "podman");
  assert.match(stdout.value(), /Engine: not configured -> podman/);
});

test("lifecycle compose commands respect engine: podman across actions", () => {
  const root = join(tmpdir(), "spaceapp-dummy");
  for (const action of ["up", "down", "status", "logs", "repair", "purge"]) {
    const cmd = composeCommand(action, root, { profile: "standard", engine: "podman" });
    assert.equal(cmd.command, "podman", `Action ${action} should dispatch podman`);
    assert.equal(cmd.args[0], "compose");
  }
});

test("ensureDockerAvailable does not fallback to podman when allowPodmanFallback is false", async () => {
  const { ensureDockerAvailable } = await import("../src/prerequisites.mjs");
  const stdout = capture();
  const stderr = capture();
  let podmanProbed = false;
  const res = await ensureDockerAvailable({
    platform: "linux",
    arch: "x64",
    stdin: ttyStdin("y"),
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      if (spec.command === "docker") return 1;
      if (spec.command === "podman") {
        podmanProbed = true;
        return 0;
      }
      return 0;
    },
    launch: async () => 0,
    pathExists: async () => true,
    sleep: async () => {},
    osRelease: { ID: "arch" },
    download: async () => { throw new Error("Arch installation must not download bootstrap files."); },
    installArgs: { allowPodmanFallback: false, autoConfirm: true, requestedProfile: "auto" }
  });
  assert.notEqual(res.engine, "podman");
  assert.equal(podmanProbed, false);
});

test("CLI backup dispatches pauseWriters, backup, and unpauseWriters to podman when configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-backup-"));
  await initializeInstallation(root, {
    version: "1.1.9",
    profile: "standard",
    accessMode: "isolated",
    engine: "podman",
    bindHost: "127.0.0.1",
    port: 8080
  });
  const stdout = capture();
  const stderr = capture();
  const executed = [];
  const exitCode = await run(["backup"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin(),
    execute: async (spec) => {
      executed.push(spec);
      return 0;
    }
  });
  assert.equal(exitCode, 0);
  const commands = executed.filter((spec) => spec.command === "podman");
  assert.ok(commands.some((spec) => spec.args?.includes("pause")));
  assert.ok(commands.some((spec) => spec.args?.includes("scripts/portable-backup.mjs")));
  assert.ok(commands.some((spec) => spec.args?.includes("unpause")));
});

test("legacy installation without engine field in config does not allow podman fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-legacy-install-"));
  await initializeInstallation(root, {
    version: "0.1.10",
    profile: "standard",
    accessMode: "isolated"
  });
  const stdout = capture();
  const stderr = capture();
  let dockerChecked = false;
  let podmanProbed = false;

  const exitCode = await run(["install", "--profile", "light", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin("y"),
    inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 40 * 1024 ** 3 }),
    ensureDocker: async ({ installArgs }) => {
      dockerChecked = true;
      assert.equal(installArgs?.allowPodmanFallback, false);
      return { code: 0, reexecuted: false };
    },
    execute: async (spec, io) => {
      if (spec.args?.includes("pg_dump")) { io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n"); return 0; }
      if (spec.command === "podman") podmanProbed = true;
      return 0;
    },
    request: async (url) => url.endsWith("/readyz")
      ? { ok: true, json: async () => ({ ok: true }) }
      : { ok: true, json: async () => ({ setupRequired: false, expiresAt: null }) }
  });

  assert.equal(exitCode, 0);
  assert.equal(dockerChecked, true);
  assert.equal(podmanProbed, false);
  const updatedConfig = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.notEqual(updatedConfig.engine, "podman");
});
