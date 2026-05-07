import { createRequire } from "node:module";
import type { createJiti } from "jiti";
import {
  buildPluginLoaderJitiOptions,
  createPluginLoaderJitiCacheKey,
  resolvePluginLoaderJitiConfig,
} from "./sdk-alias.js";

export type PluginJitiLoader = ReturnType<typeof createJiti>;
export type PluginJitiLoaderFactory = typeof createJiti;
export type PluginJitiLoaderCache = Map<string, PluginJitiLoader>;

const JITI_FACTORY_OVERRIDE_KEY = Symbol.for("openclaw.pluginJitiLoaderFactoryOverride");
const requireForJiti = createRequire(import.meta.url);
let createJitiLoaderFactory: PluginJitiLoaderFactory | undefined;

function readCreateJitiLoaderFactoryOverride(): PluginJitiLoaderFactory | undefined {
  return (
    globalThis as typeof globalThis & {
      [JITI_FACTORY_OVERRIDE_KEY]?: PluginJitiLoaderFactory;
    }
  )[JITI_FACTORY_OVERRIDE_KEY];
}

function loadCreateJitiLoaderFactory(): PluginJitiLoaderFactory {
  const override = readCreateJitiLoaderFactoryOverride();
  if (override) {
    return override;
  }
  if (createJitiLoaderFactory) {
    return createJitiLoaderFactory;
  }
  const loaded = requireForJiti("jiti") as { createJiti?: PluginJitiLoaderFactory };
  if (typeof loaded.createJiti !== "function") {
    throw new Error("jiti module did not export createJiti");
  }
  createJitiLoaderFactory = loaded.createJiti;
  return createJitiLoaderFactory;
}

export function getCachedPluginJitiLoader(params: {
  cache: PluginJitiLoaderCache;
  modulePath: string;
  importerUrl: string;
  argvEntry?: string;
  preferBuiltDist?: boolean;
  jitiFilename?: string;
  createLoader?: PluginJitiLoaderFactory;
  aliasMap?: Record<string, string>;
  tryNative?: boolean;
  cacheScopeKey?: string;
}): PluginJitiLoader {
  const defaultConfig =
    params.aliasMap || typeof params.tryNative === "boolean"
      ? resolvePluginLoaderJitiConfig({
          modulePath: params.modulePath,
          argv1: params.argvEntry ?? process.argv[1],
          moduleUrl: params.importerUrl,
          ...(params.preferBuiltDist ? { preferBuiltDist: true } : {}),
        })
      : null;
  const resolved = defaultConfig
    ? {
        tryNative: params.tryNative ?? defaultConfig.tryNative,
        aliasMap: params.aliasMap ?? defaultConfig.aliasMap,
      }
    : resolvePluginLoaderJitiConfig({
        modulePath: params.modulePath,
        argv1: params.argvEntry ?? process.argv[1],
        moduleUrl: params.importerUrl,
        ...(params.preferBuiltDist ? { preferBuiltDist: true } : {}),
      });
  const { tryNative, aliasMap } = resolved;
  const cacheKey = createPluginLoaderJitiCacheKey({
    tryNative,
    aliasMap,
  });
  const scopedCacheKey = `${params.jitiFilename ?? params.modulePath}::${params.cacheScopeKey ?? cacheKey}`;
  const cached = params.cache.get(scopedCacheKey);
  if (cached) {
    return cached;
  }
  const loader = (params.createLoader ?? loadCreateJitiLoaderFactory())(
    params.jitiFilename ?? params.modulePath,
    {
      ...buildPluginLoaderJitiOptions(aliasMap),
      tryNative,
    },
  );
  params.cache.set(scopedCacheKey, loader);
  return loader;
}
