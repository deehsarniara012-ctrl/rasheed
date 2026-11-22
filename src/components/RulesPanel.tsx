import React, { useMemo, useState } from 'react';
import { ArrowLeftRight, Plus, RotateCcw, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { COCO_CLASSES, DEFAULT_RULES, RULE_PRESETS } from '../data/cocoClasses';
import { Classification, VisionRules } from '../types/vision';
import { formatObjectLabel, normalizeTerm } from '../utils/classifier';

interface RulesPanelProps {
  rules: VisionRules;
  onChangeRules: (next: VisionRules) => void;
}

export const RulesPanel: React.FC<RulesPanelProps> = ({ rules, onChangeRules }) => {
  const [activeBucket, setActiveBucket] = useState<'negative' | 'positive'>('negative');
  const [inputValue, setInputValue] = useState('');

  const suggestions = useMemo(() => {
    const query = normalizeTerm(inputValue);
    const existing = new Set([...rules.positive, ...rules.negative].map(normalizeTerm));
    return COCO_CLASSES.filter((cls) => {
      if (existing.has(cls)) return false;
      if (!query) return true;
      return cls.includes(query);
    }).slice(0, 8);
  }, [inputValue, rules.positive, rules.negative]);

  const addRuleItem = (rawTerm: string, targetBucket: 'positive' | 'negative' = activeBucket) => {
    const term = normalizeTerm(rawTerm);
    if (!term) return;

    const otherBucket = targetBucket === 'positive' ? 'negative' : 'positive';
    const nextTarget = Array.from(new Set([...rules[targetBucket], term]));
    const nextOther = rules[otherBucket].filter((item) => normalizeTerm(item) !== term);

    onChangeRules({
      ...rules,
      [targetBucket]: nextTarget,
      [otherBucket]: nextOther,
    });
    setInputValue('');
  };

  const removeRuleItem = (term: string, bucket: 'positive' | 'negative') => {
    onChangeRules({
      ...rules,
      [bucket]: rules[bucket].filter((item) => item !== term),
    });
  };

  const moveRuleItem = (term: string, fromBucket: 'positive' | 'negative') => {
    const toBucket = fromBucket === 'positive' ? 'negative' : 'positive';
    onChangeRules({
      ...rules,
      [fromBucket]: rules[fromBucket].filter((item) => item !== term),
      [toBucket]: Array.from(new Set([...rules[toBucket], term])),
    });
  };

  const applyPreset = (presetId: string) => {
    const preset = RULE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    onChangeRules({
      ...rules,
      positive: [...preset.positive],
      negative: [...preset.negative],
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    addRuleItem(inputValue, activeBucket);
  };

  const currentItems = activeBucket === 'negative' ? rules.negative : rules.positive;

  return (
    <div className="flex flex-col gap-5">
      {/* Presets Strip */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <h3 className="text-xs font-semibold text-slate-500 tracking-wide">
            Quick Rule Presets
          </h3>
          <button
            type="button"
            onClick={() => onChangeRules(DEFAULT_RULES)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-[#0B2240] transition-colors whitespace-nowrap shrink-0 min-h-[32px] px-2 rounded-md hover:bg-slate-100 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Default</span>
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {RULE_PRESETS.map((preset) => {
            const isActive =
              JSON.stringify(preset.positive) === JSON.stringify(rules.positive) &&
              JSON.stringify(preset.negative) === JSON.stringify(rules.negative);
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.id)}
                className={`text-left px-3 py-2.5 rounded-lg border transition-colors min-h-[44px] cursor-pointer ${
                  isActive
                    ? 'border-[#0B2240] bg-[#0B2240]/5 text-[#0B2240]'
                    : 'border-slate-200 bg-white hover:border-slate-300 text-slate-800'
                }`}
              >
                <div className="text-xs font-semibold truncate">{preset.name}</div>
                <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                  {preset.positive.length} Positive · {preset.negative.length} Negative
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Positive / Negative Segmented Editor */}
      <div className="border-t border-slate-200 pt-4">
        <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg mb-3">
          <button
            type="button"
            onClick={() => setActiveBucket('negative')}
            className={`flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 min-h-[40px] cursor-pointer ${
              activeBucket === 'negative'
                ? 'bg-white text-red-700 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>Negative ({rules.negative.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveBucket('positive')}
            className={`flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 min-h-[40px] cursor-pointer ${
              activeBucket === 'positive'
                ? 'bg-white text-emerald-700 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>Positive ({rules.positive.length})</span>
          </button>
        </div>

        <p className="text-xs text-slate-600 mb-3">
          {activeBucket === 'negative'
            ? 'Items here highlight in RED and trigger the full-volume warning siren immediately.'
            : 'Items here highlight in GREEN with safe clearance labels on the camera feed.'}
        </p>

        {/* Add Rule Input */}
        <form onSubmit={handleSubmit} className="flex gap-2 mb-3">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={`Add ${activeBucket} object (e.g., knife, bottle, phone)`}
            aria-label={`Add ${activeBucket} object rule`}
            className="flex-1 min-w-0 h-11 px-3 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0B2240]/20 focus:border-[#0B2240]"
          />
          <button
            type="submit"
            disabled={!normalizeTerm(inputValue)}
            className={`inline-flex items-center justify-center gap-1.5 h-11 px-4 text-xs font-semibold text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              activeBucket === 'negative'
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            <Plus className="w-4 h-4" />
            <span>Add</span>
          </button>
        </form>

        {/* Quick Class Suggestions */}
        {suggestions.length > 0 && (
          <div className="mb-3">
            <div className="text-[11px] font-medium text-slate-500 mb-1.5">
              Quick-add supported objects:
            </div>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((cls) => (
                <button
                  key={cls}
                  type="button"
                  onClick={() => addRuleItem(cls, activeBucket)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap cursor-pointer min-h-[32px]"
                >
                  <Plus className="w-3 h-3 text-slate-500" />
                  <span>{formatObjectLabel(cls)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Active Rule List */}
        {currentItems.length === 0 ? (
          <div className="py-6 px-4 text-center border border-dashed border-slate-200 rounded-lg text-xs text-slate-500">
            No {activeBucket} objects configured. Add an object above to start classifying.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg bg-white max-h-56 overflow-y-auto">
            {currentItems.map((item) => (
              <li
                key={item}
                className="flex items-center justify-between gap-2 px-3 py-2 min-h-[44px] hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`text-[11px] font-mono font-semibold uppercase tracking-wider shrink-0 ${
                      activeBucket === 'negative' ? 'text-red-600' : 'text-emerald-600'
                    }`}
                  >
                    {activeBucket === 'negative' ? 'ALERT' : 'SAFE'}
                  </span>
                  <span className="text-slate-300" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-sm font-medium text-slate-800 truncate">
                    {formatObjectLabel(item)}
                  </span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => moveRuleItem(item, activeBucket)}
                    title={`Move to ${activeBucket === 'negative' ? 'Positive' : 'Negative'}`}
                    className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors whitespace-nowrap min-h-[36px] cursor-pointer"
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">
                      {activeBucket === 'negative' ? 'Make Positive' : 'Make Negative'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRuleItem(item, activeBucket)}
                    aria-label={`Remove ${item}`}
                    className="inline-flex items-center justify-center w-9 h-9 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Detection Sensitivity & Unlisted Rule */}
      <div className="border-t border-slate-200 pt-4 space-y-4">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="confidence-slider" className="text-xs font-semibold text-slate-700">
              Minimum Confidence
            </label>
            <span className="text-xs font-mono font-semibold text-[#0B2240] tabular-nums">
              {Math.round(rules.confidenceThreshold * 100)}%
            </span>
          </div>
          <input
            id="confidence-slider"
            type="range"
            min={30}
            max={90}
            step={5}
            value={Math.round(rules.confidenceThreshold * 100)}
            onChange={(e) =>
              onChangeRules({
                ...rules,
                confidenceThreshold: Number(e.target.value) / 100,
              })
            }
            className="w-full accent-[#0B2240] cursor-pointer"
          />
        </div>

        <div>
          <span className="block text-xs font-semibold text-slate-700 mb-1.5">
            Unlisted Objects Behavior
          </span>
          <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg">
            {(['neutral', 'positive', 'negative'] as Classification[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChangeRules({ ...rules, unlistedMode: mode })}
                className={`px-2 py-1.5 text-xs font-medium rounded-md capitalize transition-colors whitespace-nowrap min-h-[36px] cursor-pointer ${
                  rules.unlistedMode === mode
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
