import { createReadStream } from "node:fs";
import path from "node:path";

const REGULAR_ENTRY_TYPES = new Set(["File", "OldFile", "ContiguousFile"]);
const SAFE_ENTRY_TYPES = new Set([...REGULAR_ENTRY_TYPES, "Directory"]);

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export function sandboxArchiveLimits(budgets) {
  return {
    maxEntries: requirePositiveSafeInteger(budgets?.archiveMaxEntries, "archiveMaxEntries"),
    maxEntryBytes: requirePositiveSafeInteger(
      budgets?.archiveMaxEntryBytes,
      "archiveMaxEntryBytes",
    ),
    maxUnpackedBytes: requirePositiveSafeInteger(
      budgets?.archiveMaxUnpackedBytes,
      "archiveMaxUnpackedBytes",
    ),
  };
}

function normalizeEntryPath(rawPath, type, archiveLabel) {
  if (typeof rawPath !== "string" || !rawPath || rawPath.includes("\0")) {
    throw new Error(`${archiveLabel} contains an invalid archive path`);
  }
  if (rawPath.includes("\\") || path.posix.isAbsolute(rawPath) || /^[A-Za-z]:/u.test(rawPath)) {
    throw new Error(`${archiveLabel} contains an absolute or platform-specific path: ${rawPath}`);
  }
  const withoutPrefix = rawPath.replace(/^(?:\.\/)+/u, "");
  const withoutDirectorySuffix =
    type === "Directory" ? withoutPrefix.replace(/\/+$/u, "") : withoutPrefix;
  const segments = withoutDirectorySuffix.split("/");
  if (
    !withoutDirectorySuffix ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${archiveLabel} contains an unsafe path: ${rawPath}`);
  }
  return withoutDirectorySuffix;
}

export function createSandboxArchiveEntryValidator({ archiveLabel, ...rawLimits }) {
  const limits = {
    maxEntries: requirePositiveSafeInteger(rawLimits.maxEntries, "maxEntries"),
    maxEntryBytes: requirePositiveSafeInteger(rawLimits.maxEntryBytes, "maxEntryBytes"),
    maxUnpackedBytes: requirePositiveSafeInteger(rawLimits.maxUnpackedBytes, "maxUnpackedBytes"),
  };
  if (typeof archiveLabel !== "string" || !archiveLabel) {
    throw new Error("archiveLabel is required");
  }
  const paths = new Set();
  let entryCount = 0;
  let unpackedBytes = 0;

  return (entry) => {
    entryCount += 1;
    if (entryCount > limits.maxEntries) {
      throw new Error(`${archiveLabel} exceeds archive entry limit: ${entryCount}`);
    }
    if (!SAFE_ENTRY_TYPES.has(entry.type)) {
      throw new Error(`${archiveLabel} contains forbidden ${entry.type} entry: ${entry.path}`);
    }
    const normalizedPath = normalizeEntryPath(entry.path, entry.type, archiveLabel);
    if (paths.has(normalizedPath)) {
      throw new Error(`${archiveLabel} repeats archive path: ${normalizedPath}`);
    }
    paths.add(normalizedPath);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`${archiveLabel} contains an invalid entry size: ${normalizedPath}`);
    }
    if (entry.type === "Directory" && entry.size !== 0) {
      throw new Error(`${archiveLabel} contains a non-empty directory entry: ${normalizedPath}`);
    }
    if (REGULAR_ENTRY_TYPES.has(entry.type) && entry.size > limits.maxEntryBytes) {
      throw new Error(`${archiveLabel} entry exceeds size limit: ${normalizedPath}`);
    }
    unpackedBytes += entry.size;
    if (!Number.isSafeInteger(unpackedBytes) || unpackedBytes > limits.maxUnpackedBytes) {
      throw new Error(`${archiveLabel} exceeds unpacked size limit: ${unpackedBytes}`);
    }
  };
}

export async function assertSafeSandboxArchive({ archivePath, archiveLabel, limits }) {
  const { Parser } = await import("tar");
  const validateEntry = createSandboxArchiveEntryValidator({ archiveLabel, ...limits });
  await new Promise((resolve, reject) => {
    const parser = new Parser({ file: archivePath, strict: true });
    const source = createReadStream(archivePath);
    let settled = false;
    const stop = (error, abortParser) => {
      if (settled) {
        return;
      }
      settled = true;
      source.unpipe(parser);
      source.destroy();
      if (abortParser) {
        parser.abort(error);
      }
      reject(error);
    };
    parser.on("entry", (entry) => {
      try {
        validateEntry(entry);
      } catch (error) {
        stop(error, true);
        return;
      }
      entry.resume();
    });
    parser.on("error", (error) => stop(error, false));
    source.on("error", (error) => stop(error, true));
    parser.on("end", () => {
      if (!settled) {
        settled = true;
        try {
          resolve();
        } finally {
          source.destroy();
        }
      }
    });
    source.pipe(parser);
  });
}
