import React, { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Classification, DetectionLogEntry } from '../types/vision';

interface DetectionsLogProps {
  logs: DetectionLogEntry[];
  onClearLogs: () => void;
}

export const DetectionsLog: React.FC<DetectionsLogProps> = ({ logs, onClearLogs }) => {
  const [filter, setFilter] = useState<'all' | Classification>('all');

  const filteredLogs = useMemo(() => {
    if (filter === 'all') return logs;
    return logs.filter((entry) => entry.classification === filter);
  }, [logs, filter]);

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
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          {(['all', 'positive', 'negative'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md capitalize transition-colors whitespace-nowrap shrink-0 min-h-[36px] cursor-pointer ${
                filter === tab
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
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
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[36px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Clear</span>
        </button>
      </div>

      {filteredLogs.length === 0 ? (
        <div className="py-10 px-4 text-center border border-dashed border-slate-200 rounded-lg">
          <p className="text-sm font-medium text-slate-700">No detections recorded yet</p>
          <p className="text-xs text-slate-500 mt-1">
            Start the camera or test a photo to inspect real-time Positive and Negative classifications.
          </p>
        </div>
      ) : (
        <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-500">
            <span>Object & Status</span>
            <span className="text-right">Speed</span>
            <span className="text-right">Time</span>
          </div>
          <ul className="divide-y divide-slate-100 max-h-[380px] overflow-y-auto">
            {filteredLogs.map((entry) => (
              <li
                key={entry.id}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-3 py-2.5 min-h-[44px] hover:bg-slate-50 transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 truncate">
                    <span
                      className={`text-[11px] font-mono uppercase tracking-wider shrink-0 ${
                        entry.classification === 'negative'
                          ? 'text-red-600'
                          : entry.classification === 'positive'
                          ? 'text-emerald-600'
                          : 'text-slate-500'
                      }`}
                    >
                      {entry.classification}
                    </span>
                    <span className="text-slate-300" aria-hidden="true">
                      ·
                    </span>
                    <span className="truncate">{entry.label}</span>
                  </div>
                  <div className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                    {Math.round(entry.score * 100)}% confidence
                  </div>
                </div>

                <div
                  className={`text-xs font-mono font-semibold tabular-nums text-right ${
                    entry.latencyMs < 1000 ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  {Math.round(entry.latencyMs)} ms
                </div>

                <div className="text-xs font-mono text-slate-500 tabular-nums text-right">
                  {formatTime(entry.timestamp)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
