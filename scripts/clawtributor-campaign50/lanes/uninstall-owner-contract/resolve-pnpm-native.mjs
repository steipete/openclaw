import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [packagesArg, expectedName, expectedVersion] = process.argv.slice(2);
const packages = fs.realpathSync(packagesArg);
const wrapper = path.join(packages, "pnpm");
const manifest = JSON.parse(fs.readFileSync(path.join(wrapper, "package.json"), "utf8"));
if (
  manifest.name !== "pnpm" ||
  manifest.version !== expectedVersion ||
  manifest.optionalDependencies?.[expectedName] !== expectedVersion
) {
  throw new Error("Verified pnpm wrapper does not declare the exact native dependency");
}
// The caller fully verifies this installed wrapper against its pinned archive before import.
const upstream = await import(pathToFileURL(path.join(wrapper, "native-binary.mjs")).href);
const preferred = upstream.getBinCandidates()[0];
if (!preferred) throw new Error("No canonical pnpm candidate for this platform");
const selectedSpec = upstream.splitBinSpecifier(preferred);
if (selectedSpec.packageName !== expectedName) {
  throw new Error("Preferred pnpm native dependency differs from the reviewed platform");
}
const selected = upstream.resolveInstalledBinary();
if (!selected) throw new Error("Canonical pnpm resolver found no installed native binary");
const requireFromWrapper = createRequire(path.join(wrapper, "package.json"));
const metadataPath = requireFromWrapper.resolve(`${expectedName}/package.json`);
const packageRoot = path.dirname(metadataPath);
const relative = (value) => {
  const real = fs.realpathSync(value);
  const rel = path.relative(packages, real);
  if (!rel || path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) {
    throw new Error("Resolved native member is outside the owned package installation");
  }
  return rel;
};
for (const value of [metadataPath, selected]) {
  const info = fs.lstatSync(value);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Resolved native member is not a regular file");
  }
}
relative(packageRoot);
relative(metadataPath);
relative(selected);
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
if (
  metadata.name !== expectedName ||
  metadata.version !== expectedVersion ||
  !metadata.os?.includes(process.platform) ||
  !metadata.cpu?.includes(process.arch) ||
  (process.platform === "linux" && !metadata.libc?.includes("glibc"))
) {
  throw new Error("Resolved native package identity/platform differs from the reviewed package");
}
if (fs.realpathSync(selected) !== fs.realpathSync(path.join(packageRoot, selectedSpec.binFile))) {
  throw new Error("Canonical binary is not in the resolved declared native package");
}
process.stdout.write(
  JSON.stringify({
    resolver: "pnpm/native-binary.mjs.resolveInstalledBinary + declared package resolution",
    name: metadata.name,
    version: metadata.version,
    platform: process.platform,
    arch: process.arch,
    packageRoot: relative(packageRoot),
    packageJson: relative(metadataPath),
    binary: relative(selected),
  }) + "\n",
);
