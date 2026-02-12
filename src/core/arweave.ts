/**
 * Read-only Arweave interaction. Pure fetch, no SDK dependency.
 * Queries use the GraphQL gateway. Downloads use the data endpoint.
 */

const DEFAULT_GQL_ENDPOINTS = [
  "https://arweave.net/graphql",
  "https://g8way.io/graphql",
];
const DEFAULT_DATA_ENDPOINTS = [
  "https://arweave.net",
  "https://g8way.io",
];
const ARWEAVE_GQL_ENDPOINTS = parseEndpointList(
  process.env.SHARME_ARWEAVE_GQLS,
  DEFAULT_GQL_ENDPOINTS
);
const ARWEAVE_DATA_ENDPOINTS = parseEndpointList(
  process.env.SHARME_ARWEAVE_DATAS,
  DEFAULT_DATA_ENDPOINTS
);
const GQL_PAGE_SIZE = 1000;
const GQL_MAX_PAGES = 1000;

export interface ShardInfo {
  txId: string;
  version: number;
  type: "delta" | "snapshot" | "identity";
  timestamp: string;
  signature: string | null;
  wallet: string;
}

export interface ConversationChunkInfo {
  txId: string;
  wallet: string;
  client: "cursor" | "claude-code";
  project: string;
  session: string;
  chunkIndex: number;
  chunkTotal: number;
  offset: number;
  count: number;
  timestamp: string;
  signature: string | null;
}

export interface ConversationShareInfo {
  txId: string;
  shareId: string;
  wallet: string;
  timestamp: string;
  signature: string | null;
}

/**
 * Query Arweave for all shards belonging to a wallet.
 * Returns them sorted by version ascending.
 */
export async function queryShards(walletAddress: string): Promise<ShardInfo[]> {
  const shards: ShardInfo[] = [];
  const seenTxIds = new Set<string>();
  let after: string | null = null;
  let pageCount = 0;

  const query = `
    query($wallet: String!, $first: Int!, $after: String) {
      transactions(
        tags: [
          { name: "App-Name", values: ["sharme"] },
          { name: "Wallet", values: [$wallet] }
        ],
        sort: HEIGHT_ASC,
        first: $first,
        after: $after
      ) {
        pageInfo { hasNextPage }
        edges {
          cursor
          node {
            id
            tags { name value }
          }
        }
      }
    }
  `;

  while (true) {
    pageCount += 1;
    if (pageCount > GQL_MAX_PAGES) {
      throw new Error(
        `Arweave GraphQL pagination exceeded ${GQL_MAX_PAGES} pages.`
      );
    }

    const json = (await gqlRequest({
      query,
      variables: {
        wallet: walletAddress,
        first: GQL_PAGE_SIZE,
        after,
      },
    })) as {
      data?: {
        transactions?: {
          pageInfo?: { hasNextPage?: boolean };
          edges?: Array<{
            cursor: string;
            node: { id: string; tags: Array<{ name: string; value: string }> };
          }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message ?? "unknown").join("; ");
      throw new Error(`Arweave GraphQL returned errors: ${msg}`);
    }

    const transactions = json.data?.transactions;
    const edges = transactions?.edges ?? [];
    if (edges.length === 0) break;

    for (const edge of edges) {
      if (seenTxIds.has(edge.node.id)) continue;
      seenTxIds.add(edge.node.id);

      const tagMap = new Map(edge.node.tags.map((t) => [t.name, t.value]));
      const rawType = tagMap.get("Type");
      if (
        rawType !== "delta" &&
        rawType !== "snapshot" &&
        rawType !== "identity"
      ) {
        continue;
      }

      const wallet = tagMap.get("Wallet") ?? "";
      if (!wallet || wallet.toLowerCase() !== walletAddress.toLowerCase()) {
        continue;
      }

      const rawSignature = tagMap.get("Signature")?.trim() ?? "";
      const signature = rawSignature.length > 0 ? rawSignature : null;
      const timestamp = tagMap.get("Timestamp") ?? "";

      // Strict parsing:
      // - delta/snapshot require a valid integer version and a signature
      // - identity can omit version (set to 0) but still requires a signature
      let version = 0;
      if (rawType === "delta" || rawType === "snapshot") {
        const rawVersion = tagMap.get("Version");
        if (!rawVersion) continue;
        const parsedVersion = Number.parseInt(rawVersion, 10);
        if (!Number.isFinite(parsedVersion) || parsedVersion < 1) continue;
        if (!signature) continue;
        version = parsedVersion;
      } else {
        if (!signature) continue;
      }

      shards.push({
        txId: edge.node.id,
        version,
        type: rawType,
        timestamp,
        signature,
        wallet,
      });
    }

    const lastCursor = edges[edges.length - 1]?.cursor ?? null;
    const hasNextPage = transactions?.pageInfo?.hasNextPage === true;
    if (!hasNextPage || !lastCursor) break;
    after = lastCursor;
  }

  // Sort by version ascending (GraphQL HEIGHT_ASC is by block, not version)
  shards.sort((a, b) => a.version - b.version);
  return shards;
}

/**
 * Query Arweave for conversation chunks belonging to a wallet.
 * Returns all conversation transactions (paginated) with parsed metadata.
 */
export async function queryConversationChunks(
  walletAddress: string
): Promise<ConversationChunkInfo[]> {
  const chunks: ConversationChunkInfo[] = [];
  const seenTxIds = new Set<string>();
  let after: string | null = null;
  let pageCount = 0;

  const query = `
    query($wallet: String!, $first: Int!, $after: String) {
      transactions(
        tags: [
          { name: "App-Name", values: ["sharme"] },
          { name: "Wallet", values: [$wallet] },
          { name: "Type", values: ["conversation"] }
        ],
        sort: HEIGHT_ASC,
        first: $first,
        after: $after
      ) {
        pageInfo { hasNextPage }
        edges {
          cursor
          node {
            id
            tags { name value }
          }
        }
      }
    }
  `;

  while (true) {
    pageCount += 1;
    if (pageCount > GQL_MAX_PAGES) {
      throw new Error(
        `Arweave GraphQL pagination exceeded ${GQL_MAX_PAGES} pages.`
      );
    }

    const json = (await gqlRequest({
      query,
      variables: { wallet: walletAddress, first: GQL_PAGE_SIZE, after },
    })) as {
      data?: {
        transactions?: {
          pageInfo?: { hasNextPage?: boolean };
          edges?: Array<{
            cursor: string;
            node: { id: string; tags: Array<{ name: string; value: string }> };
          }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message ?? "unknown").join("; ");
      throw new Error(`Arweave GraphQL returned errors: ${msg}`);
    }

    const transactions = json.data?.transactions;
    const edges = transactions?.edges ?? [];
    if (edges.length === 0) break;

    for (const edge of edges) {
      if (seenTxIds.has(edge.node.id)) continue;
      seenTxIds.add(edge.node.id);

      const tagMap = new Map(edge.node.tags.map((t) => [t.name, t.value]));
      const wallet = tagMap.get("Wallet") ?? "";
      if (!wallet || wallet.toLowerCase() !== walletAddress.toLowerCase()) {
        continue;
      }

      const client = tagMap.get("Client");
      if (client !== "cursor" && client !== "claude-code") continue;

      const project = tagMap.get("Project") ?? "";
      const session = tagMap.get("Session") ?? "";
      if (!project || !session) continue;

      const rawChunk = tagMap.get("Chunk") ?? "1/1";
      const chunkParts = rawChunk.split("/");
      const chunkIndex = Number.parseInt(chunkParts[0] ?? "1", 10);
      const chunkTotal = Number.parseInt(chunkParts[1] ?? "1", 10);
      if (
        !Number.isFinite(chunkIndex) ||
        !Number.isFinite(chunkTotal) ||
        chunkIndex < 1 ||
        chunkTotal < 1 ||
        chunkIndex > chunkTotal
      ) {
        continue;
      }

      const rawOffset = tagMap.get("Offset");
      const rawCount = tagMap.get("Count");
      const offset = rawOffset ? Number.parseInt(rawOffset, 10) : 0;
      const count = rawCount ? Number.parseInt(rawCount, 10) : 0;
      if (!Number.isFinite(offset) || offset < 0) continue;
      if (!Number.isFinite(count) || count < 0) continue;

      const rawSignature = tagMap.get("Signature")?.trim() ?? "";
      const signature = rawSignature.length > 0 ? rawSignature : null;
      if (!signature) continue;

      chunks.push({
        txId: edge.node.id,
        wallet,
        client,
        project,
        session,
        chunkIndex,
        chunkTotal,
        offset,
        count,
        timestamp: tagMap.get("Timestamp") ?? "",
        signature,
      });
    }

    const lastCursor = edges[edges.length - 1]?.cursor ?? null;
    const hasNextPage = transactions?.pageInfo?.hasNextPage === true;
    if (!hasNextPage || !lastCursor) break;
    after = lastCursor;
  }

  chunks.sort((a, b) => {
    if (a.session !== b.session) return a.session.localeCompare(b.session);
    if (a.offset !== b.offset) return a.offset - b.offset;
    if (a.chunkIndex !== b.chunkIndex) return a.chunkIndex - b.chunkIndex;
    return a.timestamp.localeCompare(b.timestamp);
  });
  return chunks;
}

/**
 * Query Arweave for a conversation share transaction by Share-Id.
 * Returns the newest matching transaction.
 */
export async function queryConversationShare(
  shareId: string
): Promise<ConversationShareInfo | null> {
  const query = `
    query($shareId: String!) {
      transactions(
        tags: [
          { name: "App-Name", values: ["sharme"] },
          { name: "Type", values: ["conversation-share"] },
          { name: "Share-Id", values: [$shareId] }
        ],
        sort: HEIGHT_DESC,
        first: 1
      ) {
        edges {
          node {
            id
            tags { name value }
          }
        }
      }
    }
  `;

  const json = (await gqlRequest({
    query,
    variables: { shareId },
  })) as {
    data?: {
      transactions?: {
        edges?: Array<{
          node: { id: string; tags: Array<{ name: string; value: string }> };
        }>;
      };
    };
    errors?: Array<{ message?: string }>;
  };

  if (json.errors && json.errors.length > 0) {
    const msg = json.errors.map((e) => e.message ?? "unknown").join("; ");
    throw new Error(`Arweave GraphQL returned errors: ${msg}`);
  }

  const node = json.data?.transactions?.edges?.[0]?.node;
  if (!node) return null;

  const tagMap = new Map(node.tags.map((t) => [t.name, t.value]));
  const type = tagMap.get("Type");
  const taggedShareId = tagMap.get("Share-Id");
  if (type !== "conversation-share" || taggedShareId !== shareId) {
    return null;
  }

  const wallet = tagMap.get("Wallet") ?? "";
  const timestamp = tagMap.get("Timestamp") ?? "";
  const rawSignature = tagMap.get("Signature")?.trim() ?? "";
  const signature = rawSignature.length > 0 ? rawSignature : null;

  return {
    txId: node.id,
    shareId,
    wallet,
    timestamp,
    signature,
  };
}

/**
 * Download a shard's raw data from Arweave.
 */
export async function downloadShard(txId: string, maxBytes?: number): Promise<Uint8Array> {
  const errors: string[] = [];
  for (const endpoint of ARWEAVE_DATA_ENDPOINTS) {
    try {
      const res = await fetch(`${endpoint}/${txId}`);
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }

      if (typeof maxBytes === "number") {
        const contentLength = res.headers.get("content-length");
        if (contentLength) {
          const declared = Number.parseInt(contentLength, 10);
          if (Number.isFinite(declared) && declared > maxBytes) {
            throw new Error(
              `blob too large: ${declared} bytes (max ${maxBytes})`
            );
          }
        }
      }

      const buffer = await res.arrayBuffer();
      if (typeof maxBytes === "number" && buffer.byteLength > maxBytes) {
        throw new Error(
          `blob too large: ${buffer.byteLength} bytes (max ${maxBytes})`
        );
      }
      return new Uint8Array(buffer);
    } catch (err) {
      errors.push(
        `${endpoint}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  throw new Error(
    `Arweave download failed for ${txId} across all gateways: ${errors.join(" | ")}`
  );
}

/**
 * Find the identity transaction for a wallet (Type: "identity").
 * Returns the salt (from tags) and encrypted private key (from data).
 */
export async function fetchIdentity(
  walletAddress: string,
  identityMaxBytes = 16 * 1024
): Promise<{ salt: Uint8Array; encryptedPrivateKey: Uint8Array } | null> {
  const shards = await queryShards(walletAddress);
  const identityTxs = shards.filter((s) => s.type === "identity" && !!s.signature);
  if (identityTxs.length === 0) return null;
  const identityTx = identityTxs.sort((a, b) => {
    const ta = Number.parseInt(a.timestamp, 10);
    const tb = Number.parseInt(b.timestamp, 10);
    const sa = Number.isFinite(ta) ? ta : 0;
    const sb = Number.isFinite(tb) ? tb : 0;
    if (sa !== sb) return sb - sa; // newest first
    return b.txId.localeCompare(a.txId);
  })[0];

  // Salt is stored as a hex string in tags
  const query = `
    query {
      transactions(ids: ["${identityTx.txId}"]) {
        edges {
          node {
            id
            tags { name value }
          }
        }
      }
    }
  `;

  const json = (await gqlRequest({ query })) as {
    data: {
      transactions: {
        edges: Array<{
          node: { id: string; tags: Array<{ name: string; value: string }> };
        }>;
      };
    };
  };

  const edge = json.data.transactions.edges[0];
  if (!edge) return null;

  const tagMap = new Map(edge.node.tags.map((t) => [t.name, t.value]));
  const saltHex = tagMap.get("Salt");
  if (!saltHex) return null;

  const salt = Buffer.from(saltHex, "hex");
  const encryptedPrivateKey = await downloadShard(identityTx.txId, identityMaxBytes);

  return { salt: new Uint8Array(salt), encryptedPrivateKey };
}

function parseEndpointList(envValue: string | undefined, fallback: string[]): string[] {
  if (!envValue || envValue.trim() === "") return fallback;
  const values = envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\/+$/, ""));
  return values.length > 0 ? values : fallback;
}

async function gqlRequest(body: { query: string; variables?: Record<string, unknown> }): Promise<unknown> {
  const errors: string[] = [];
  for (const endpoint of ARWEAVE_GQL_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      errors.push(
        `${endpoint}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  throw new Error(
    `Arweave GraphQL request failed across all gateways: ${errors.join(" | ")}`
  );
}
