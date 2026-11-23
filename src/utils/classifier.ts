import { CLASS_SYNONYMS } from '../data/cocoClasses';
import { Classification, VisionRules } from '../types/vision';

export function normalizeTerm(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function matchesRuleTerm(detectedText: string, ruleTerm: string): boolean {
  const detected = normalizeTerm(detectedText);
  const rule = normalizeTerm(ruleTerm);
  if (!rule || !detected) return false;
  if (detected === rule) return true;

  const synonyms = CLASS_SYNONYMS[detected] ?? [];
  if (synonyms.some((syn) => syn === rule || detected.includes(rule))) return true;

  for (const [canonical, aliases] of Object.entries(CLASS_SYNONYMS)) {
    if (canonical === detected && aliases.includes(rule)) {
      return true;
    }
    if (rule === canonical && aliases.includes(detected)) {
      return true;
    }
  }

  return detected.includes(rule) || rule.includes(detected);
}

export function classifyDetection(
  rawClass: string,
  rules: VisionRules,
  extraLabels: string[] = []
): { classification: Classification; matchedRule?: string } {
  const candidates = [rawClass, ...extraLabels].filter(Boolean);

  // Fail-safe: check Negative rules across all label candidates first
  for (const candidate of candidates) {
    for (const term of rules.negative) {
      if (matchesRuleTerm(candidate, term)) {
        return { classification: 'negative', matchedRule: term };
      }
    }
  }

  for (const candidate of candidates) {
    for (const term of rules.positive) {
      if (matchesRuleTerm(candidate, term)) {
        return { classification: 'positive', matchedRule: term };
      }
    }
  }

  return { classification: rules.unlistedMode };
}

export function formatObjectLabel(rawClass: string): string {
  return normalizeTerm(rawClass)
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
