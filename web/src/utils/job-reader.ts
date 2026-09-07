import { api } from '../services/client.js';
import type { ArtifactChunkDto, JobReadResponseDto } from '../types/api.js';
import { base64ToBytes } from './crypto-artifact.js';

export interface ReadArtifactResult {
  text: string;
  totalBytes: number;
  chunkCount: number;
  artifactMeta?: {
    media_type: string;
    byte_length: number;
    sha256: string;
    expires_at: string;
  };
}

/**
 * Hard safety caps aligned with Cloud 16 MiB artifact contract.
 * Protects against infinite pagination, cursor cycle loops, and OOM.
 */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024; // 16 MiB
export const MAX_ARTIFACT_CHUNKS = 10_000;
export const MAX_ARTIFACT_PAGES = 500;

/**
 * Reads complete artifact data across all chunk pages according to the real backend contract.
 * Concatenates raw bytes in offset order and decodes as full UTF-8 with strict error handling.
 */
export async function readFullJobArtifact(
  jobId: string,
  onProgress?: (loadedChunks: number, totalChunks?: number) => void
): Promise<ReadArtifactResult> {
  let cursor: string | undefined = undefined;
  const allChunks: ArtifactChunkDto[] = [];
  let artifactMeta: JobReadResponseDto['artifact'] | undefined = undefined;
  let pageCount = 0;
  let accumulatedBytes = 0;
  const visitedCursors = new Set<string>();

  do {
    if (pageCount >= MAX_ARTIFACT_PAGES) {
      throw new Error(`超出最大产物读取分页数限制 (${MAX_ARTIFACT_PAGES})`);
    }

    if (cursor) {
      if (visitedCursors.has(cursor)) {
        throw new Error(`检测到循环分页游标: ${cursor}`);
      }
      visitedCursors.add(cursor);
    }

    const previousChunkCount = allChunks.length;
    const res: JobReadResponseDto = await api.jobs.read(jobId, {
      cursor,
      page_size: 50,
    });

    if (res.artifact && !artifactMeta) {
      artifactMeta = res.artifact;
      if (artifactMeta.byte_length > MAX_ARTIFACT_BYTES) {
        throw new Error(`产物声明大小 (${artifactMeta.byte_length} bytes) 超出 16 MiB 上限`);
      }
    }

    if (res.chunks && res.chunks.length > 0) {
      for (const chunk of res.chunks) {
        accumulatedBytes += chunk.byte_length;
        if (accumulatedBytes > MAX_ARTIFACT_BYTES) {
          throw new Error(`产物累计大小超出 16 MiB 上限`);
        }
      }
      allChunks.push(...res.chunks);
      if (allChunks.length > MAX_ARTIFACT_CHUNKS) {
        throw new Error(`产物分块总数超出上限 (${MAX_ARTIFACT_CHUNKS})`);
      }
    }

    pageCount++;

    // No-progress detection: if a next_cursor is returned but no chunks were added, it indicates an infinite loop
    if (res.next_cursor && allChunks.length === previousChunkCount) {
      throw new Error(`分页拉取无增量进展 (next_cursor: ${res.next_cursor})`);
    }

    cursor = res.next_cursor;
    if (onProgress) {
      onProgress(allChunks.length);
    }
  } while (cursor);

  // If metadata says there should be bytes, but no chunks were returned
  const expectedTotalLength = artifactMeta?.byte_length;
  if (allChunks.length === 0) {
    if (expectedTotalLength && expectedTotalLength > 0) {
      throw new Error(`元数据声明大小为 ${expectedTotalLength} bytes，但未读取到任何分块数据`);
    }
    return {
      text: '',
      totalBytes: 0,
      chunkCount: 0,
      artifactMeta,
    };
  }

  // Sort chunks strictly by index and offset
  allChunks.sort((a, b) => a.index - b.index);

  // Check strict index continuity: 0, 1, 2, ..., N - 1
  for (let i = 0; i < allChunks.length; i++) {
    if (allChunks[i]!.index !== i) {
      throw new Error(`产物分块索引不连续: 期望 ${i}，实际 ${allChunks[i]!.index}`);
    }
  }

  // Compute total byte length and verify metadata
  let totalLength = 0;
  for (const c of allChunks) {
    totalLength += c.byte_length;
  }
  if (expectedTotalLength !== undefined && expectedTotalLength !== totalLength) {
    throw new Error(`产物实际字节数 (${totalLength}) 与元数据声明 (${expectedTotalLength}) 不一致`);
  }

  const fullBuffer = new Uint8Array(totalLength);
  let nextOffset = 0;
  for (const c of allChunks) {
    const chunkBytes = base64ToBytes(c.data_base64);
    if (chunkBytes.byteLength !== c.byte_length || c.offset !== nextOffset) {
      throw new Error(`产物分块长度或偏移不连续 (期望偏移 ${nextOffset}，实际 ${c.offset})`);
    }
    fullBuffer.set(chunkBytes, nextOffset);
    nextOffset += chunkBytes.byteLength;
  }

  // Decode complete binary buffer as strict UTF-8 (fatal: true to prevent silent corruption)
  let text = '';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(fullBuffer);
  } catch (err) {
    throw new Error(`产物内容无法按 UTF-8 严格解码: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    text,
    totalBytes: totalLength,
    chunkCount: allChunks.length,
    artifactMeta,
  };
}
