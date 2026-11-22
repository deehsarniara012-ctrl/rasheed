import { CLASS_SYNONYMS } from '../data/cocoClasses';
import { Classification, VisionRules } from '../types/vision';

export function normalizeTerm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchesRuleTerm(detectedClass: string, ruleTerm: string): boolean {
  const detected = normalizeTerm(detectedClass);
  const rule = normalizeTerm(ruleTerm);
  if (!rule) return false;
  if (detected === rule) return true;

  const synonyms = CLASS_SYNONYMS[detected] ?? [];
  if (synonyms.includes(rule)) return true;

  // Also check if user typed a COCO class that maps via reverse synonym
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
  rules: VisionRules
): { classification: Classification; matchedRule?: string } {
  // Check Negative rules first for fail-safe alerting
  for (const term of rules.negative) {
    if (matchesRuleTerm(rawClass, term)) {
      return { classification: 'negative', matchedRule: term };
    }
  }

  for (const term of rules.positive) {
    if (matchesRuleTerm(rawClass, term)) {
      return { classification: 'positive', matchedRule: term };
    }
  }

  return { classification: rules.unlistedMode };
}

export function formatObjectLabel(rawClass: string): string {
  return rawClass
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
