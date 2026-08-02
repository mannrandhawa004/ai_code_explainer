import {
  LineBasedChunker,
  RepositoryLineBasedChunker,
  type LineBasedChunkerOptions,
  type LineChunkSourceMetadata,
  type SourceFileChunkingResult,
} from "./line-based-chunker.js";
import { TreeSitterCodeChunker } from "./tree-sitter-chunker.js";

export class RepositoryTreeSitterChunker extends RepositoryLineBasedChunker {
  constructor(
    private readonly treeSitterChunker: TreeSitterCodeChunker =
      new TreeSitterCodeChunker(),
    lineChunker: LineBasedChunker = new LineBasedChunker(),
  ) {
    super(lineChunker);
  }

  protected override chunkSource(
    content: string,
    metadata: LineChunkSourceMetadata,
    options: LineBasedChunkerOptions | undefined,
  ): SourceFileChunkingResult {
    return this.treeSitterChunker.chunk(content, metadata, options);
  }
}
