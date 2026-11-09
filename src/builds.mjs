// Builds: the agent packages campaigns run, kept unchanged once added, each with a manifest that says what it is: version, commit, where it came from,
// its checksum, and the changelog of its version (what features it has). A campaign names a build by id, so a result always points at the exact code
// that produced it; replacing a file on disk cannot change what an old result refers to.
//   <data>/builds/<id>/package.tgz   the package
//   <data>/builds/<id>/manifest.json { id, name, version, commit, source, sha256, size, addedAt, note, changelog }
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { paths } from "./campaign.mjs";

export const REPO = process.env.AMNESS_GIT ?? "https://github.com/amirsdream/Amness.git";
const dir = () => join(paths.data, "builds");
const run = (cmd, args, opts = {}) => new Promise((ok, no) => execFile(cmd, args, { maxBuffer: 64 << 20, timeout: 20 * 60_000, ...opts }, (err, stdout, stderr) => (err ? no(new Error(`${cmd} ${args.join(" ")}: ${String(stderr || err.message).trim().split("\n").slice(-3).join(" ")}`)) : ok(String(stdout)))));

export function listBuilds() {
  if (!existsSync(dir())) return [];
  return readdirSync(dir()).map((id) => { try { return JSON.parse(readFileSync(join(dir(), id, "manifest.json"), "utf8")); } catch { return null; } }).filter(Boolean).sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
}
export function getBuild(id) { try { return JSON.parse(readFileSync(join(dir(), id, "manifest.json"), "utf8")); } catch { return null; } }
export const buildPackage = (id) => join(dir(), id, "package.tgz");

/** A campaign's `build` may be an id, a version ("0.7.2": the newest build of it), or "latest". */
export function resolveBuild(ref) {
  if (!ref) return null;
  const all = listBuilds();
  return all.find((b) => b.id === ref) ?? (ref === "latest" ? all.find((b) => !b.note?.startsWith("dev")) : all.find((b) => b.version === String(ref).replace(/^v/, ""))) ?? null;
}

/** The changelog section of `version` from a CHANGELOG.md text ("## 0.7.2 (date)" up to the next "## "). */
export function changelogSection(text, version) {
  const m = new RegExp(`^## ${version.replace(/\./g, "\\.")}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(text ?? "");
  return m ? m[1].trim() : "";
}
/** Its bullet points as features: the bold lead of each bullet, or its first sentence. */
export function features(section) {
  return section.split("\n").filter((l) => /^- /.test(l)).map((l) => { const b = /^- \*\*(.+?)\*\*/.exec(l); return (b ? b[1] : l.slice(2).split(/(?<=\.) /)[0]).replace(/[.:]$/, ""); });
}

async function readPackageJson(tgz) { return JSON.parse(await run("tar", ["-xOzf", tgz, "package/package.json"])); }
async function changelogFor(version, gitDir) {
  try { if (gitDir && existsSync(join(gitDir, "CHANGELOG.md"))) return changelogSection(readFileSync(join(gitDir, "CHANGELOG.md"), "utf8"), version); } catch { /* fall through */ }
  try { const r = await fetch(`${REPO.replace(/\.git$/, "").replace("github.com", "raw.githubusercontent.com")}/v${version}/CHANGELOG.md`, { signal: AbortSignal.timeout(15_000) }); if (r.ok) return changelogSection(await r.text(), version); } catch { /* offline */ }
  return "";
}

/**
 * Add a build from `spec`: a path to a packed .tgz, an npm version ("0.7.2", "npm:0.7.2"), or a git ref ("git:main", "git:v0.7.2", "git:<sha>").
 * Returns the manifest. The same package twice gives the same id (its checksum), so adding is safe to repeat.
 */
export async function addBuild(spec, { note = "", say = () => {} } = {}) {
  const work = mkdtempSync(join(tmpdir(), "studio-build-")); let tgz, source, commit = null, gitDir = null;
  try {
    if (/\.tgz$/.test(spec) && existsSync(spec)) { tgz = resolve(spec); source = { kind: "file", path: tgz }; }
    else if (/^git:/.test(spec)) {
      const ref = spec.slice(4); gitDir = join(paths.data, "builds", ".git-cache");
      if (!existsSync(join(gitDir, ".git"))) { say(`cloning ${REPO}`); mkdirSync(gitDir, { recursive: true }); await run("git", ["clone", "--quiet", REPO, gitDir]); }
      say(`checking out ${ref}`); await run("git", ["-C", gitDir, "fetch", "--quiet", "--tags", "origin"]); await run("git", ["-C", gitDir, "checkout", "--quiet", "--force", ref.startsWith("v") || /^[0-9a-f]{7,}$/.test(ref) ? ref : `origin/${ref}`]);
      commit = (await run("git", ["-C", gitDir, "rev-parse", "HEAD"])).trim();
      say("installing and building"); await run("npm", ["ci", "--no-fund", "--no-audit"], { cwd: gitDir, env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" } }); await run("npm", ["run", "build", "--silent"], { cwd: gitDir });
      const name = (await run("npm", ["pack", "--silent", "--pack-destination", work], { cwd: gitDir })).trim().split("\n").pop(); tgz = join(work, name);
      source = { kind: "git", repo: REPO, ref };
    } else {
      const v = spec.replace(/^npm:/, "").replace(/^v/, ""); say(`fetching amness@${v} from npm`);
      const name = (await run("npm", ["pack", "--silent", `amness@${v}`, "--pack-destination", work], { cwd: work })).trim().split("\n").pop(); tgz = join(work, name);
      try { commit = JSON.parse(await run("npm", ["view", `amness@${v}`, "gitHead", "--json"])) || null; } catch { /* not published with one */ }
      source = { kind: "npm", spec: `amness@${v}` };
    }
    const bytes = readFileSync(tgz), sha256 = createHash("sha256").update(bytes).digest("hex"), pkg = await readPackageJson(tgz);
    const id = `${pkg.name}-${pkg.version}-${sha256.slice(0, 8)}`, d = join(dir(), id);
    if (existsSync(join(d, "manifest.json"))) return JSON.parse(readFileSync(join(d, "manifest.json"), "utf8"));
    const changelog = await changelogFor(pkg.version, gitDir);
    const manifest = { id, name: pkg.name, version: pkg.version, commit, source, sha256, size: bytes.length, addedAt: new Date().toISOString(), note, changelog, features: features(changelog) };
    const part = d + ".part"; rmSync(part, { recursive: true, force: true }); mkdirSync(part, { recursive: true });
    copyFileSync(tgz, join(part, "package.tgz")); writeFileSync(join(part, "manifest.json"), JSON.stringify(manifest, null, 2)); renameSync(part, d);
    say(`added build ${id}`); return manifest;
  } finally { rmSync(work, { recursive: true, force: true }); }
}
