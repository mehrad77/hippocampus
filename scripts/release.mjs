// Computes the next CLI version from git tags + conventional commits, without committing anything
// (main is protected; the version lives in `v*` tags, not in a committed package.json).
//
//   node scripts/release.mjs            print the next version (empty if nothing to release)
//   node scripts/release.mjs --write    also stamp it into apps/cli/package.json for the build
//
// Used by the release job in .github/workflows/ci.yml.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const PKG = "apps/cli/package.json";

/** Conventional-commit bump type for a set of commit messages. */
export function bumpType(messages) {
  if (messages.some((m) => /^\w+(\([^)]*\))?!:/m.test(m) || /^BREAKING[ -]CHANGE:/m.test(m))) return "major";
  if (messages.some((m) => /^feat(\([^)]*\))?:/m.test(m))) return "minor";
  return "patch";
}

/** Next semver. Before 1.0.0, breaking changes bump the minor version. */
export function nextVersion(current, type) {
  const [major, minor, patch] = current.split(".").map(Number);
  const effective = type === "major" && major === 0 ? "minor" : type;
  if (effective === "major") return `${major + 1}.0.0`;
  if (effective === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function lastTag() {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*");
  } catch {
    return undefined;
  }
}

function main() {
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  const tag = lastTag();
  let version;
  if (!tag) {
    // First release: the version already in package.json.
    version = pkg.version;
  } else {
    const messages = git("log", `${tag}..HEAD`, "--format=%B%x00")
      .split("\0")
      .map((m) => m.trim())
      .filter(Boolean);
    if (!messages.length) {
      console.error(`nothing to release since ${tag}`);
      return;
    }
    version = nextVersion(tag.slice(1), bumpType(messages));
  }

  if (process.argv.includes("--write")) {
    pkg.version = version;
    writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(version);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
