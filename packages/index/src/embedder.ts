/** Turns text into vectors for semantic recall. Adapters live in `@hippocampus/embeddings`. */
export interface Embedder {
  /** The model's identity (e.g. `ollama:nomic-embed-text`). Vectors from another id are re-embedded. */
  readonly id: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}
