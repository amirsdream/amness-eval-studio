# Amness Evaluation Studio

Run coding-agent benchmarks as **resumable campaigns**, and watch them **live in a browser**: what the agent is doing right now, step by step, and how each variant is doing so far.

Built for [Amness](https://github.com/amirsdream/Amness) and its harness experiments (switch one guard off, compare), on [Terminal-Bench 2.0](https://www.tbench.ai/) through [Harbor](https://pypi.org/project/harbor/). It works with any agent Harbor can run.

In this page you will learn:

- what a campaign is, and how to run one in short sessions or unattended
- how to install the studio on a server (or a Proxmox container)
- what the live UI shows

## What a campaign is

A campaign is a file in `campaigns/`: a task list (`subsets/<name>.txt`), a model, the variants to compare, and the number of trials.

```json
{
  "subset": "mini",
  "model": "custom/qwen-vllm",
  "args": ["--ak", "endpoint=http://my-gpu-box:8000/v1"],
  "trials": 1,
  "variants": {
    "full": [],
    "no-pin": ["--ak", "off=pin"],
    "tool-required": ["--ak", "tool_choice=required"]
  }
}
```

The runs go task by task, with every variant of a task together, so each session adds pairs you can compare. Each finished run is saved at once. Stop anywhere: at most the run in progress is lost, and it runs again next time.

A run where Harbor failed before the agent started (Docker, the image, installing the agent) is not a result about the agent. It is not recorded, and it runs again. Three such failures in a row stop the campaign, so a broken setup does not fill the results with false failures.

## Run it

You need Node 20+, Docker with Compose, and Harbor (`uv tool install harbor`).

```bash
node bin/studio.mjs run streams --minutes 30    # a 30-minute session; a run starts only if it should finish in time
node bin/studio.mjs run streams --minutes 0     # until it is done
node bin/studio.mjs status streams              # progress and results so far
node bin/studio.mjs serve --port 8090           # the live UI
```

Terminal-Bench images are built for x86_64. On an Apple Silicon Mac (or another ARM machine) they run under emulation and are much slower. Run the studio on an x86_64 Linux machine when you can.

## Install on a server

On Debian or Ubuntu (also inside a Proxmox LXC with `nesting=1`), from a checkout of this repository:

```bash
sudo deploy/install-debian.sh
sudo systemctl edit amness-studio-run        # Environment=CAMPAIGN=<your campaign>
sudo systemctl enable --now amness-studio-run
```

It installs Docker with Compose, Node, uv and Harbor, and two services: the runner (resumes after a reboot) and the UI on port 8090.

To run Amness from a packed tarball (a server without the Amness repository), put `"--ak", "package=/path/amness.tgz"` in the campaign's `args`. Build it in the Amness repository with `npm run build && npm pack`.

## The live UI

- **Progress:** runs done, time left, the model and the dataset.
- **Now:** the run in progress. Its phase (setting up, the agent working, the tests running), how long it has run, model requests, tokens sent, the share served from the prompt cache, tokens received, a chart of the prompt size per request, and a feed of what the agent does: each command and file it touches, edits, its messages, and the harness's guard actions (nudges, refusals). It updates every two seconds.
- **Variants:** pass rate with a 95% interval (Wilson), tasks won and lost against the first variant on the same task, timeouts, median tokens and time, tokens per solved task.
- **Tasks:** a task × variant grid. Click a cell for the run.
- **A run:** the agent's final answer, everything it did, the task's test output, and Harbor's error if there was one.

The UI is read-only: it cannot start or stop anything. It has no login, so keep it on your own network (or behind a reverse proxy with authentication).

## Limits

- One run at a time. A model server with one slot (a llama.cpp default) answers one request at a time anyway.
- With few tasks the intervals are wide: 8 tasks run once can show large effects only. Repeat a difference before believing it.
- The live feed reads Amness's `--json` events. Other agents show their phase and result, but not each step.

## Plans

Starting and pausing campaigns from the browser (with a login), comparing two campaigns, reports for sharing, more datasets (SWE-bench through Harbor, Amness's own suites), and `amness eval --remote` to submit a campaign from the Amness terminal or desktop app.

## License

MIT
