/* Everything server.js needs has to be inside the image.
 *
 * This exists because the app shipped completely dead once. server.js grew a
 * `require('./dashboard-summary')`, the Dockerfile copied `server.js` and
 * `send-reminders.js` and nothing else, and the container died on boot with
 * MODULE_NOT_FOUND. The whole test suite was green throughout — every test in
 * this directory runs against the source tree, and the source tree has the file.
 * Nothing here looks at what actually gets into the image.
 *
 * The published :latest was broken for as long as it took to notice, because
 * publish-image.yml does not depend on docker-build.yml passing: the smoke test
 * failed and the image went out anyway.
 *
 * So: every top-level `require('./x')` in a file that ships must correspond to
 * something the Dockerfile copies. Cheap, and it fails at the desk rather than
 * in a container.
 *
 *     node test/docker-payload.js
 */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");

// What the image actually receives: every COPY target, plus whole directories.
const copied = new Set();
const dirs = [];
dockerfile.split("\n").forEach((line) => {
  const m = line.match(/^COPY\s+(?!--from)(.+?)\s+\.?\/?\S*$/);
  if (!m) return;
  m[1].split(/\s+/).forEach((tok) => {
    if (tok.startsWith("--")) return;
    if (tok.includes("*")) { copied.add(tok); return; }
    const abs = path.join(ROOT, tok);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) dirs.push(tok);
    copied.add(tok);
  });
});

const inImage = (rel) => {
  if (copied.has(rel)) return true;
  if (dirs.some((d) => rel === d || rel.startsWith(d + "/"))) return true;
  // package*.json style globs
  return [...copied].some((c) => {
    if (!c.includes("*")) return false;
    const re = new RegExp("^" + c.replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$");
    return re.test(rel);
  });
};

// The entrypoints that actually run inside the container.
const ENTRYPOINTS = ["server.js", "send-reminders.js"];

ENTRYPOINTS.forEach((entry) => {
  assert.ok(inImage(entry), `${entry} runs in the container but is not COPYed.`);
  const src = fs.readFileSync(path.join(ROOT, entry), "utf8");
  const locals = [...new Set([...src.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)].map((m) => m[1]))];
  locals.forEach((spec) => {
    const rel = spec.replace(/^\.\//, "");
    const candidates = rel.endsWith(".js") ? [rel] : [rel + ".js", rel + "/index.js", rel];
    const found = candidates.find((c) => fs.existsSync(path.join(ROOT, c)));
    assert.ok(found, `${entry} requires ${spec} which does not exist on disk.`);
    assert.ok(inImage(found),
      `${entry} requires ${spec}, but the Dockerfile never copies ${found}. ` +
      `The container will boot straight into MODULE_NOT_FOUND and die — and no ` +
      `other test in this suite will notice, because they all run against the ` +
      `source tree. Add it to the COPY line.`);
  });
});

// public/ is the whole product; losing it serves a blank app rather than an error.
assert.ok(inImage("public/index.html"), "the Dockerfile must copy public/.");

// A file the .dockerignore drops must not then be required by something shipping.
const ignored = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
ENTRYPOINTS.forEach((entry) => {
  const src = fs.readFileSync(path.join(ROOT, entry), "utf8");
  [...src.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)].forEach((m) => {
    const top = m[1].split("/")[0];
    assert.ok(!ignored.includes(top),
      `${entry} requires ./${m[1]}, but .dockerignore excludes "${top}".`);
  });
});

console.log("Docker payload: OK — everything server.js requires is inside the image");
