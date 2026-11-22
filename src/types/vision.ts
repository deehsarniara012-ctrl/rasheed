export type Classification = 'positive' | 'negative' | 'neutral';

export interface DetectedItem {
  id: string;
  rawClass: string;
  displayLabel: string;
  score: number;
  bbox: [number, number, number, number];
  classification: Classification;
}

export interface DetectionLogEntry {
  id: string;
  timestamp: number;
  label: string;
  rawClass: string;
  score: number;
  classification: Classification;
  latencyMs: number;
}

export interface VisionRules {
  positive: string[];
  negative: string[];
  confidenceThreshold: number;
  unlistedMode: Classification;
}

export interface RulePreset {
  id: string;
  name: string;
  description: string;
  positive: string[];
  negative: string[];
}
