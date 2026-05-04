import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSessionStore, type SessionEntry } from "../src/config/sessions.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { normalizeAgentId } from "../src/routing/session-key.js";

export const DEFAULT_SOURCE_ROOT = path.join(os.homedir(), ".openclaw", "agents");

export type SeedOptions = {
  inflateTranscriptKiB: number;
  sessions: number;
  sourceRoot: string;
  sourceStore?: string;
};

export type SeedResult = {
  config: OpenClawConfig;
  root: string;
  seed: {
    clonedBytes: number;
    mode: "real-clone";
    sourceRows: number;
    sourceStores: number;
    sourceTranscripts: number;
    transcriptInflateKiB: number;
    writtenBytes: number;
  };
  storePath: string;
};

type SourceStore = {
  agentId: string;
  storePath: string;
};

type RealSessionSource = SourceStore & {
  bytes: number;
  entry: SessionEntry;
  key: string;
  transcriptPath: string;
};

type CloneRoundMaps = {
  byIdentity: Map<string, string>;
  byKey: Map<string, string>;
};

type ClonePlan = {
  cloneKey: string;
  cloneSessionFile: string;
  cloneSessionId: string;
  index: number;
  maps: CloneRoundMaps;
  source: RealSessionSource;
};

function inferAgentIdFromStorePath(storePath: string): string {
  const sessionsDir = path.dirname(storePath);
  if (path.basename(sessionsDir) === "sessions") {
    return normalizeAgentId(path.basename(path.dirname(sessionsDir)));
  }
  return "main";
}

function discoverSourceStores(options: SeedOptions): SourceStore[] {
  if (options.sourceStore) {
    const storePath = path.resolve(options.sourceStore);
    return [{ agentId: inferAgentIdFromStorePath(storePath), storePath }];
  }
  const root = path.resolve(options.sourceRoot);
  if (!fs.existsSync(root)) {
    throw new Error(`source agents root not found: ${root}`);
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      agentId: normalizeAgentId(entry.name),
      storePath: path.join(root, entry.name, "sessions", "sessions.json"),
    }))
    .filter((entry) => fs.existsSync(entry.storePath))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function resolveSourceTranscriptPath(params: {
  entry: SessionEntry;
  sourceStorePath: string;
}): string | undefined {
  const sourceDir = path.dirname(params.sourceStorePath);
  const candidates: string[] = [];
  if (params.entry.sessionFile) {
    candidates.push(
      path.isAbsolute(params.entry.sessionFile)
        ? params.entry.sessionFile
        : path.join(sourceDir, params.entry.sessionFile),
    );
  }
  candidates.push(path.join(sourceDir, `${params.entry.sessionId}.jsonl`));
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function loadRealSessionSources(options: SeedOptions): {
  rows: number;
  sourceStores: number;
  sources: RealSessionSource[];
} {
  const stores = discoverSourceStores(options);
  const sources: RealSessionSource[] = [];
  let rows = 0;
  for (const sourceStore of stores) {
    const store = loadSessionStore(sourceStore.storePath, { skipCache: true, clone: false });
    rows += Object.keys(store).length;
    for (const [key, entry] of Object.entries(store)) {
      if (!entry.sessionId) {
        continue;
      }
      const transcriptPath = resolveSourceTranscriptPath({
        entry,
        sourceStorePath: sourceStore.storePath,
      });
      if (!transcriptPath) {
        continue;
      }
      sources.push({
        ...sourceStore,
        bytes: fs.statSync(transcriptPath).size,
        entry,
        key,
        transcriptPath,
      });
    }
  }
  return { rows, sourceStores: stores.length, sources };
}

function sourceIdentity(source: Pick<RealSessionSource, "agentId" | "key">): string {
  return `${source.agentId}\t${source.key}`;
}

function createRoundMaps(sources: RealSessionSource[], round: number, count: number) {
  const maps: CloneRoundMaps = { byIdentity: new Map(), byKey: new Map() };
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex];
    if (!source) {
      continue;
    }
    const index = round * sources.length + sourceIndex;
    if (index >= count) {
      break;
    }
    const padded = String(index + 1).padStart(5, "0");
    const cloneKey = `agent:${source.agentId}:bench-real-${padded}`;
    maps.byIdentity.set(sourceIdentity(source), cloneKey);
    maps.byKey.set(source.key, cloneKey);
  }
  return maps;
}

function buildClonePlans(params: { count: number; sources: RealSessionSource[] }): ClonePlan[] {
  const plans: ClonePlan[] = [];
  const rounds = Math.ceil(params.count / params.sources.length);
  for (let round = 0; round < rounds; round += 1) {
    const maps = createRoundMaps(params.sources, round, params.count);
    for (let sourceIndex = 0; sourceIndex < params.sources.length; sourceIndex += 1) {
      const index = round * params.sources.length + sourceIndex;
      if (index >= params.count) {
        break;
      }
      const padded = String(index + 1).padStart(5, "0");
      const source = params.sources[sourceIndex];
      if (!source) {
        continue;
      }
      const cloneKey = maps.byIdentity.get(sourceIdentity(source));
      if (!cloneKey) {
        throw new Error(`missing clone key for ${source.key}`);
      }
      const cloneSessionId = `bench-${source.agentId}-${padded}`;
      plans.push({
        cloneKey,
        cloneSessionFile: `${cloneSessionId}.jsonl`,
        cloneSessionId,
        index,
        maps,
        source,
      });
    }
  }
  return plans;
}

function agentIdFromCanonicalKey(value: string): string | undefined {
  const match = /^agent:([^:]+):/.exec(value);
  return match ? normalizeAgentId(match[1]) : undefined;
}

function remapSessionLink(
  value: string | undefined,
  source: RealSessionSource,
  maps: CloneRoundMaps,
) {
  if (!value) {
    return value;
  }
  const linkedAgentId = agentIdFromCanonicalKey(value) ?? source.agentId;
  return maps.byIdentity.get(`${linkedAgentId}\t${value}`) ?? maps.byKey.get(value) ?? value;
}

function copyTranscript(params: { inflateBytes: number; source: string; target: string }): {
  sourceBytes: number;
  writtenBytes: number;
} {
  const sourceStat = fs.statSync(params.source);
  if (params.inflateBytes <= sourceStat.size) {
    fs.copyFileSync(params.source, params.target);
    return { sourceBytes: sourceStat.size, writtenBytes: sourceStat.size };
  }
  const source = fs.readFileSync(params.source);
  const chunk =
    source[source.length - 1] === 10 ? source : Buffer.concat([source, Buffer.from("\n")]);
  const fd = fs.openSync(params.target, "w");
  let writtenBytes = 0;
  try {
    while (writtenBytes < params.inflateBytes) {
      const remaining = params.inflateBytes - writtenBytes;
      const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
      fs.writeSync(fd, slice);
      writtenBytes += slice.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sourceBytes: sourceStat.size, writtenBytes };
}

function createBenchConfig(root: string, agentIds: string[]): OpenClawConfig {
  return {
    session: { store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json") },
    agents: {
      list: agentIds.map((id, index) => ({ id, name: id, default: index === 0 })),
    },
  };
}

export function seedRealSessions(options: SeedOptions): SeedResult {
  const { rows, sources, sourceStores } = loadRealSessionSources(options);
  if (sources.length === 0) {
    throw new Error(`no cloneable transcript-backed sessions under ${options.sourceRoot}`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-list-bench-"));
  const agentIds = [...new Set(sources.map((source) => source.agentId))].sort();
  const stores = new Map<string, Record<string, SessionEntry>>();
  let clonedBytes = 0;
  let writtenBytes = 0;
  const inflateBytes = options.inflateTranscriptKiB * 1024;
  const now = Date.now();

  for (const plan of buildClonePlans({ count: options.sessions, sources })) {
    const sessionsDir = path.join(root, "agents", plan.source.agentId, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const copied = copyTranscript({
      inflateBytes,
      source: plan.source.transcriptPath,
      target: path.join(sessionsDir, plan.cloneSessionFile),
    });
    clonedBytes += copied.sourceBytes;
    writtenBytes += copied.writtenBytes;
    const store = stores.get(plan.source.agentId) ?? {};
    store[plan.cloneKey] = {
      ...plan.source.entry,
      parentSessionKey: remapSessionLink(
        plan.source.entry.parentSessionKey,
        plan.source,
        plan.maps,
      ),
      sessionFile: plan.cloneSessionFile,
      sessionId: plan.cloneSessionId,
      spawnedBy: remapSessionLink(plan.source.entry.spawnedBy, plan.source, plan.maps),
      updatedAt: now - plan.index * 1000,
    };
    stores.set(plan.source.agentId, store);
  }

  for (const [agentId, store] of stores) {
    const sessionsDir = path.join(root, "agents", agentId, "sessions");
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), `${JSON.stringify(store)}\n`);
  }

  return {
    root,
    storePath: "(multiple)",
    config: createBenchConfig(root, agentIds),
    seed: {
      clonedBytes,
      mode: "real-clone",
      sourceRows: rows,
      sourceStores,
      sourceTranscripts: sources.length,
      transcriptInflateKiB: options.inflateTranscriptKiB,
      writtenBytes,
    },
  };
}
