import React, { useMemo, useState } from 'react';
import { Box, Search, Trash2 } from 'lucide-react';
import { Classification, DetectionLogEntry } from '../types/vision';
import { Inspectable3DItem } from './Alert3DModal';

interface DetectionsLogProps {
  logs: DetectionLogEntry[];
  onClearLogs: () => void;
  onInspect3D: (item: Inspectable3DItem) => void;
}

export const DetectionsLog: React.FC<DetectionsLogProps> = ({
  logs,
  onClearLogs,
  onInspect3D,
}) => {
  const [filter, setFilter] = useState<'all' | Classification>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return logs.filter((entry) => {
      if (filter !== 'all' && entry.classification !== filter) return false;
      if (!q) return true;
      return (
        entry.label.toLowerCase().includes(q) ||
        entry.rawClass.toLowerCase().includes(q)
      );
    });
  }, [logs, filter, searchQuery]);

  const formatTime = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl">
          {(['all', 'positive', 'negative'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 text-xs font-bold rounded-xl capitalize transition-colors whitespace-nowrap shrink-0 min-h-[36px] cursor-pointer ${
                filter === tab
                  ? tab === 'negative'
                    ? 'bg-[#DC2626] text-white shadow-xs'
                    : tab === 'positive'
                    ? 'bg-[#0B4FE6] text-white shadow-xs'
                    : 'bg-white dark:bg-slate-950 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onClearLogs}
          disabled={logs.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-xl transition-colors whitespace-nowrap shrink-0 min-h-[36px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Clear</span>
        </button>
      </div>

      {/* Live Search Input */}
      <div className="relative">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search detections by label or class..."
          aria-label="Search detection logs"
          className="w-full h-10 pl-9 pr-3 text-xs bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B4FE6]/25 focus:border-[#0B4FE6]"
        />
      </div>

      {filteredLogs.length === 0 ? (
        <div className="py-10 px-4 text-center border border-dashed border-slate-200 dark:border-slate-800 rounded-2xl">
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            No detections match your filter
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Start the camera or test a photo to inspect real-time Positive and Negative classifications.
          </p>
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-950/60 overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-3.5 py-2.5 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            <span>Object & Status</span>
            <span className="text-right">Speed</span>
            <span className="text-right">3D / Time</span>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800/80 max-h-[420px] overflow-y-auto">
            {filteredLogs.map((entry) => (
              <li
                key={entry.id}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-3.5 py-2.5 min-h-[52px] hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {entry.thumbnailUrl && (
                    <img
                      src={entry.thumbnailUrl}
                      alt={entry.label}
                      className="w-10 h-8 rounded-lg object-cover border border-slate-200 dark:border-slate-700 bg-slate-900 shrink-0"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-white truncate">
                      <span
                        className={`text-[11px] font-mono uppercase tracking-wider shrink-0 ${
                          entry.classification === 'negative'
                            ? 'text-red-600 dark:text-red-400'
                            : entry.classification === 'positive'
                            ? 'text-[#0B4FE6] dark:text-blue-400'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {entry.classification}
                      </span>
                      <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                        ·
                      </span>
                      <span className="truncate">{entry.label}</span>
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                      {Math.round(entry.score * 100)}% confidence
                    </div>
                  </div>
                </div>

                <div
                  className={`text-xs font-mono font-semibold tabular-nums text-right ${
                    entry.latencyMs < 1000
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-amber-700 dark:text-amber-400'
                  }`}
                >
                  {Math.round(entry.latencyMs)} ms
                </div>

                <div className="flex flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      onInspect3D({
                        id: entry.id,
                        label: entry.label,
                        classification: entry.classification,
                        score: entry.score,
                        thumbnailUrl: entry.thumbnailUrl,
                        timestamp: entry.timestamp,
                      })
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-50 dark:bg-blue-950/60 hover:bg-[#0B4FE6] text-[#0B4FE6] dark:text-blue-300 hover:text-white text-[10px] font-bold transition-colors cursor-pointer"
                  >
                    <Box className="w-3 h-3" />
                    <span>3D Pic</span>
                  </button>
                  <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                    {formatTime(entry.timestamp)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
