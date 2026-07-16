import type { LiteParseToolConfig } from "./types.ts";

export interface NativeParseJob {
  operation: "parse";
  filePath: string;
  parserConfig: LiteParseToolConfig;
  outputDir: string;
}

export interface NativeSearchJob {
  operation: "search";
  filePath: string;
  parserConfig: LiteParseToolConfig;
  phrase: string;
  caseSensitive: boolean;
  maxResults: number;
}

export interface NativeScreenshotJob {
  operation: "screenshot";
  filePath: string;
  parserConfig: LiteParseToolConfig;
  pageNumbers?: number[];
  outputDir: string;
}

export type NativeDocumentJob = NativeParseJob | NativeSearchJob | NativeScreenshotJob;

export interface NativeParseResult {
  outputFormat: "text" | "json";
  outputPath: string;
  pageCount: number;
}

export interface NativeSearchHit {
  pageNum: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
  confidence?: number;
}

export interface NativeSearchResult {
  hits: NativeSearchHit[];
}

export interface NativeScreenshotArtifact {
  pageNum: number;
  width: number;
  height: number;
  outputPath: string;
  bytes: number;
}

export interface NativeScreenshotResult {
  screenshotDir: string;
  screenshots: NativeScreenshotArtifact[];
}

export type NativeDocumentResult = NativeParseResult | NativeSearchResult | NativeScreenshotResult;
