"""Run Amness inside Harbor (the harness of Terminal-Bench 2.0) as an installed agent.

    PYTHONPATH=bench/harbor harbor run -d terminal-bench@2.0 -a amness_agent:Amness -m openai/gpt-6-luna

The agent installs Node and Amness in the task container, runs `amness run --json` on the task,
and reports tokens and cost back to Harbor. Model: `provider/model`, where provider is one of
openai, anthropic, openrouter, ollama, custom (custom and ollama need `--ak endpoint=http://host:port/v1`).
Keys come from the host's environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, or AMNESS_API_KEY for any provider).

Options (`--ak name=value`): package (`local` = pack this working tree, default; a path to a packed .tgz, for a machine without the repository; or an npm version such as 0.5.2),
endpoint (the server's base URL; Harbor reserves `base_url` for its own credential handling), off (guards to switch off, comma separated), plugin (plugin files on the host, comma separated),
effort, max_steps, max_tokens, context_window, api, verify, tool_choice (auto or required), max_time (seconds; default: the task's limit minus a margin),
thinking_budget (most thinking tokens per model request, for llama.cpp; Amness 0.7.2+), request (a JSON object of extra request fields, such as {"temperature":0.6}; Amness 0.7.2+),
runtime (`cache`, default: Node and Amness are installed once on the host into a cached bundle that each container unpacks, with no network; `off`: install them in
every container with nvm and npm, as before). The bundle is rebuilt when the package changes; a container where it does not work (no glibc, another CPU) falls back.
"""

import fcntl
import glob
import hashlib
import json
import os
import tomllib
import shlex
import subprocess
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REPO = Path(os.environ.get("AMNESS_REPO", Path(__file__).resolve().parents[2]))   # package=local packs this Amness checkout
RT = "/opt/amness-rt"   # where the cached bundle is unpacked in the container
NODE = f'export PATH="{RT}/bin:{RT}/node/bin:$PATH"; export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true'
CACHE = Path(os.environ.get("AMNESS_STUDIO_CACHE", Path.home() / ".cache" / "amness-studio"))
NODE_LINE = os.environ.get("AMNESS_RT_NODE", "22")      # Node major version in the bundle
NODE_ARCH = os.environ.get("AMNESS_RT_ARCH", "x64")     # the containers' CPU: Terminal-Bench images are amd64
KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY"}
_packed: Path | None = None


def _pack() -> Path:
    """`npm pack` this working tree once per Harbor process, so a run tests the code you have, not a release."""
    global _packed
    if _packed is None or not _packed.exists():
        out = Path(tempfile.mkdtemp(prefix="amness-harbor-"))
        subprocess.run(["npm", "run", "build", "--silent"], cwd=REPO, check=True, stdout=subprocess.DEVNULL)
        name = subprocess.run(["npm", "pack", "--silent", "--pack-destination", str(out)], cwd=REPO, check=True, capture_output=True, text=True).stdout.strip().splitlines()[-1]
        _packed = out / name
    return _packed


def _node_tarball() -> Path:
    """The official Node build for Linux (the newest of NODE_LINE), downloaded once."""
    CACHE.mkdir(parents=True, exist_ok=True)
    have = sorted(CACHE.glob(f"node-v{NODE_LINE}.*-linux-{NODE_ARCH}.tar.xz"))
    if have:
        return have[-1]
    base = f"https://nodejs.org/dist/latest-v{NODE_LINE}.x/"
    sums = urllib.request.urlopen(base + "SHASUMS256.txt", timeout=60).read().decode()
    line = next(l for l in sums.splitlines() if l.endswith(f"-linux-{NODE_ARCH}.tar.xz"))
    digest, name = line.split()
    data = urllib.request.urlopen(base + name, timeout=600).read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError(f"checksum mismatch for {name}")
    (CACHE / (name + ".part")).write_bytes(data)
    (CACHE / (name + ".part")).rename(CACHE / name)
    return CACHE / name


def _runtime(package: Path) -> Path:
    """A tarball with Node and Amness (and its dependencies) installed under one folder, built once per package and reused by every run."""
    node = _node_tarball()
    key = hashlib.sha256(package.read_bytes() + node.name.encode()).hexdigest()[:16]
    out = CACHE / f"runtime-{key}.tgz"
    if out.exists():
        return out
    with open(CACHE / "runtime.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)   # two runs at once build it only once
        if out.exists():
            return out
        work = Path(tempfile.mkdtemp(prefix="amness-rt-", dir=CACHE))
        try:
            with tarfile.open(node) as t:
                t.extractall(work, filter="tar")
            next(work.glob("node-v*")).rename(work / "node")
            env = {**os.environ, "ELECTRON_SKIP_BINARY_DOWNLOAD": "1", "PATH": f"{work / 'node' / 'bin'}:{os.environ.get('PATH', '')}"}
            npm = [str(work / "node" / "bin" / "npm")]
            try:
                subprocess.run([*npm, "--version"], env=env, check=True, capture_output=True)
            except OSError:
                npm = ["npm"]   # the host cannot run Linux x64 Node (a Mac): its own npm installs the same JavaScript
            subprocess.run([*npm, "install", "-g", "--prefix", str(work), "--no-fund", "--no-audit", "--ignore-scripts", str(package)], env=env, check=True, capture_output=True)
            part = out.with_suffix(".part")
            with tarfile.open(part, "w:gz") as t:
                for name in ("node", "bin", "lib"):
                    t.add(work / name, arcname=name)
            part.rename(out)
            for old in CACHE.glob("runtime-*.tgz"):
                if old != out and old.stat().st_mtime < out.stat().st_mtime - 7 * 86400:
                    old.unlink(missing_ok=True)   # bundles of packages unused for a week
        finally:
            shutil.rmtree(work, ignore_errors=True)
    return out


class Amness(BaseInstalledAgent):
    """Amness (https://github.com/amirsdream/Amness): a hackable coding-agent harness."""

    def __init__(self, *args, package: str = "local", endpoint: str | None = None, off: str | None = None, plugin: str | None = None,
                 effort: str | None = None, max_steps: int | None = None, max_tokens: int | None = None, context_window: int | None = None,
                 api: str | None = None, verify: str | None = None, max_time: int | None = None, tool_choice: str | None = None, runtime: str = "cache",
                 thinking_budget: int | None = None, request: str | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.package, self.endpoint, self.off, self.plugins = package, endpoint, off, [p for p in (plugin or "").split(",") if p]
        self.max_time, self.runtime = max_time, runtime
        self.flags = {"--effort": effort, "--max-steps": max_steps, "--max-tokens": max_tokens, "--context-window": context_window, "--api": api, "--verify": verify, "--tool-choice": tool_choice,
                      "--thinking-budget": thinking_budget, "--request": request}

    def _task_timeout(self) -> float | None:
        """The task's agent time limit (task.toml `agent.timeout_sec` x the trial's multiplier), read from the trial's config and Harbor's task cache."""
        try:
            cfg = json.loads((Path(self.logs_dir).parent / "config.json").read_text())
            name = Path(cfg["task"]["path"]).name
            mult = float(cfg.get("agent_timeout_multiplier") or cfg.get("timeout_multiplier") or 1.0)
            for f in glob.glob(str(Path.home() / ".cache/harbor/tasks/*" / name / "task.toml")):
                t = tomllib.loads(Path(f).read_text()).get("agent", {}).get("timeout_sec")
                if t:
                    return float(t) * mult
        except Exception:
            return None
        return None

    @staticmethod
    @override
    def name() -> str:
        return "amness"

    @override
    def get_version_command(self) -> str | None:
        return f"{NODE}; amness --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if self.runtime != "off" and (self.package == "local" or self.package.endswith(".tgz")) and await self._install_cached(environment):
            return
        await self.ensure_system_dependencies(environment, ("curl", "git"))
        await self.exec_as_agent(environment, command=f"set -e; {nvm_node_install_snippet(22)}")
        if self.package == "local" or self.package.endswith(".tgz"):
            await environment.upload_file(_pack() if self.package == "local" else Path(self.package).expanduser().resolve(), "/tmp/amness.tgz")
            target = "/tmp/amness.tgz"
        else:
            target = f"amness@{self.package}"
        # Electron (the desktop app) is not needed in a benchmark container: skip its download.
        await self.exec_as_agent(environment, command=f"set -e; {NODE}; ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install -g --no-fund --no-audit {shlex.quote(target)} && amness --version")
        for i, p in enumerate(self.plugins):
            await environment.upload_file(Path(p).expanduser().resolve(), f"/tmp/amness-plugin-{i}{Path(p).suffix}")

    async def _install_cached(self, environment: BaseEnvironment) -> bool:
        """Unpack the cached bundle: a few seconds, no network. False when it cannot be used here, so `install` takes the slow path."""
        try:
            pkg = _pack() if self.package == "local" else Path(self.package).expanduser().resolve()
            await environment.upload_file(_runtime(pkg), "/tmp/amness-rt.tgz")
            await self.exec_as_root(environment, command=f"mkdir -p {RT} && tar -xzf /tmp/amness-rt.tgz -C {RT} && chmod -R a+rX {RT} && rm -f /tmp/amness-rt.tgz && {RT}/node/bin/node -e 0")
            await self.ensure_system_dependencies(environment, ("git",))
            await self.exec_as_agent(environment, command=f"{NODE}; amness --version")
        except Exception as e:   # noqa: BLE001: any failure means "use the slow path"
            self.logger.warning(f"cached runtime not usable here, installing with nvm and npm: {e}")
            return False
        for i, p in enumerate(self.plugins):
            await environment.upload_file(Path(p).expanduser().resolve(), f"/tmp/amness-plugin-{i}{Path(p).suffix}")
        return True

    @override
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("model must be provider/model, for example openai/gpt-6-luna or custom/qwen-vllm")
        provider, model = self.model_name.split("/", 1)
        env = {"AMNESS_TASK": instruction, "AMNESS_HOME": "/tmp/amness-home", "AMNESS_NOTIFY": "off", "ELECTRON_SKIP_BINARY_DOWNLOAD": "1"}
        key = os.environ.get("AMNESS_API_KEY") or os.environ.get(KEY_ENV.get(provider, "OPENAI_API_KEY"))
        if key:
            env[KEY_ENV.get(provider, "OPENAI_API_KEY")] = key
        args = ["run", "--yes", "--json", "--no-memory", "--cwd", ".", "--provider", provider, "--model", model, "--trace", "/logs/agent/amness.trace.jsonl"]
        if self.endpoint:
            args += ["--base-url", self.endpoint]
        if self.off:
            args += ["--off", self.off]
        if self.plugins:
            args += ["--plugin", ",".join(f"/tmp/amness-plugin-{i}{Path(p).suffix}" for i, p in enumerate(self.plugins))]
        limit = self.max_time or (lambda t: int(t - max(60, t * 0.1)) if t else None)(self._task_timeout())   # stop before Harbor does, so the run ends with a report
        if limit:
            args += ["--max-time", str(limit)]
        for flag, value in self.flags.items():
            if value not in (None, ""):
                args += [flag, json.dumps(value) if isinstance(value, (dict, list)) else str(value)]   # Harbor may hand `--ak request={...}` over already parsed
        cmd = (f"{NODE}; mkdir -p /logs/agent; printf '%s' \"$AMNESS_TASK\" | amness {' '.join(shlex.quote(a) for a in args)} - "
               "> /logs/agent/amness.jsonl 2> /logs/agent/amness.stderr; echo $? > /logs/agent/amness.exit; exit 0")   # exit 1 = not finished: the verifier decides, so the trial goes on
        await self.exec_as_agent(environment, command=cmd, env=env)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Tokens and cost from the last `result` line of `amness run --json`. When the run was cut off (Harbor's agent timeout)
        there is no result line, so the per-request `turn` events are added up instead (no cost then: it needs the model's price)."""
        log = Path(self.logs_dir) / "amness.jsonl"
        if not log.exists():
            return
        result, turns = None, {"prompt": 0, "cached": 0, "completion": 0}
        for line in log.read_text(errors="replace").splitlines():
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(e, dict):
                continue
            if e.get("kind") == "result":
                result = e
            elif e.get("kind") == "turn":
                for k in turns:
                    turns[k] += int(e.get(k) or 0)
        usage = (result or {}).get("usage") or turns
        context.n_input_tokens = usage.get("prompt")
        context.n_cache_tokens = usage.get("cached")
        context.n_output_tokens = usage.get("completion")
        if result and result.get("cost") is not None:
            context.cost_usd = result["cost"]
