/**
 * Read-only Arweave interaction. Pure fetch, no SDK dependency.
 * Queries use the GraphQL gateway. Downloads use the data endpoint.
 */
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
export declare function queryShards(walletAddress: string): Promise<ShardInfo[]>;
/**
 * Query Arweave for conversation chunks belonging to a wallet.
 * Returns all conversation transactions (paginated) with parsed metadata.
 */
export declare function queryConversationChunks(walletAddress: string): Promise<ConversationChunkInfo[]>;
/**
 * Query Arweave for a conversation share transaction by Share-Id.
 * Returns the newest matching transaction.
 */
export declare function queryConversationShare(shareId: string): Promise<ConversationShareInfo | null>;
/**
 * Download a shard's raw data from Arweave.
 */
export declare function downloadShard(txId: string, maxBytes?: number): Promise<Uint8Array>;
/**
 * Find the identity transaction for a wallet (Type: "identity").
 * Returns the salt (from tags) and encrypted private key (from data).
 */
export declare function fetchIdentity(walletAddress: string, identityMaxBytes?: number): Promise<{
    salt: Uint8Array;
    encryptedPrivateKey: Uint8Array;
} | null>;
//# sourceMappingURL=arweave.d.ts.map