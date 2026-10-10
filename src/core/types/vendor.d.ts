/**
 * Ambient module declarations for optional native dependencies.
 *
 * These modules are loaded dynamically at runtime when installed.
 * Consolidated from the former src/stubs/ directory.
 */

declare module 'hnswlib-node' {
  export const HierarchicalNSW: any;
}

declare module 'graphology' {
  export default class Graph {
    constructor(options?: any);
    [key: string]: any;
  }
}

declare module 'graphology-communities-louvain' {
  const louvain: (graph: any, options?: any) => any;
  export default louvain;
}

declare module 'sharp' {
  interface SharpRawOptions {
    width: number;
    height: number;
    channels: number;
  }

  interface Sharp {
    removeAlpha(): Sharp;
    ensureAlpha(alpha?: number): Sharp;
    toColourspace(space: string): Sharp;
    greyscale(greyscale?: boolean): Sharp;
    grayscale(grayscale?: boolean): Sharp;
    negate(options?: any): Sharp;
    sharpen(options?: any): Sharp;
    normalize(options?: any): Sharp;
    flatten(options?: any): Sharp;
    composite(images: any[]): Sharp;
    joinChannel(images: any, options?: { raw?: SharpRawOptions }): Sharp;
    extract(region: { left: number; top: number; width: number; height: number }): Sharp;
    png(options?: any): Sharp;
    raw(): Sharp;
    toBuffer(): Promise<Buffer>;
    toBuffer(options: { resolveWithObject: boolean }): Promise<{ data: Buffer; info: any }>;
    resize(width?: number, height?: number, options?: any): Sharp;
    toFormat(format: string, options?: any): Sharp;
    metadata(): Promise<any>;
  }

  function sharp(
    input?: Buffer | string | ArrayBuffer | { create?: any; text?: any; raw?: any },
    options?: { raw?: SharpRawOptions; [key: string]: any },
  ): Sharp;
  export default sharp;
}

declare module 'tesseract.js' {
  const Tesseract: {
    createWorker: (lang: string) => Promise<any>;
  };
  export default Tesseract;
}

declare module 'ppu-paddle-ocr' {
  export const PaddleOcrService: any;
}

declare module '@xenova/transformers' {
  export const env: any;
  export const pipeline: any;
}

declare module '@huggingface/transformers' {
  export const env: any;
  export const pipeline: any;
  export const AutoProcessor: any;
  export const Florence2ForConditionalGeneration: any;
  export const RawImage: any;
}

declare module '@framers/agentos-extensions-registry' {
  export interface RegistryOptions {
    [key: string]: unknown;
  }
  export interface CuratedRegistryEntry {
    id: string;
    name: string;
    category: string;
    [key: string]: any;
  }
  export function createCuratedManifest(options?: RegistryOptions): any;
  export const CHANNEL_CATALOG: Record<string, any>;
  export const TOOL_CATALOG: CuratedRegistryEntry[];
  export const SECRET_ENV_MAP: Record<string, string>;
}

declare module '@prisma/client' {
  export class PrismaClient {
    [key: string]: any;
  }
}
