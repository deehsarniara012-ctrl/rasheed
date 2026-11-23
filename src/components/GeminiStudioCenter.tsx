import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ExternalLink,
  Film,
  Globe,
  Image as ImageIcon,
  Loader2,
  MapPin,
  MessageSquare,
  Mic,
  MicOff,
  Music,
  Send,
  Sparkles,
  Square,
  Upload,
  Volume2,
} from 'lucide-react';
import { CloudChatMessage } from '../lib/firebase';
import { GeoCoordinates } from '../types/vision';

interface GeminiStudioCenterProps {
  coords: GeoCoordinates | null;
  telemetrySummary: string;
  userUid: string | null;
  cloudMessages: CloudChatMessage[];
  onSaveChatMessage: (msg: CloudChatMessage) => void;
  onLogAiSession: (title: string, summary: string, modelUsed: string) => void;
}

type StudioTab = 'chat' | 'voice' | 'image' | 'media';

interface LocalChatTurn {
  id: string;
  role: 'user' | 'model';
  text: string;
  modelUsed: string;
  groundingMode: 'none' | 'search' | 'maps';
  sources: Array<{ title: string; uri: string; kind: 'web' | 'maps' }>;
  createdAtMs: number;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function float32ToPcm16Base64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return uint8ToBase64(new Uint8Array(int16.buffer));
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

function fileToBase64Parts(file: File): Promise<{ base64: string; mimeType: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
      resolve({
        base64,
        mimeType: file.type || 'application/octet-stream',
        dataUrl,
      });
    };
    reader.onerror = () => reject(new Error('Failed to read selected file.'));
    reader.readAsDataURL(file);
  });
}

export const GeminiStudioCenter: React.FC<GeminiStudioCenterProps> = ({
  coords,
  telemetrySummary,
  userUid,
  cloudMessages,
  onSaveChatMessage,
  onLogAiSession,
}) => {
  const [activeTab, setActiveTab] = useState<StudioTab>('chat');

  // --- Tab 1: Chatbot & Grounding ---
  const [chatModel, setChatModel] = useState<
    'gemini-4-hydrogen' | 'gemini-3.1-flash-lite' | 'gemini-4-neon' | 'gemini-4-carbon'
  >('gemini-4-hydrogen');
  const [thinkingLevel, setThinkingLevel] = useState<'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH'>('LOW');
  const [groundingMode, setGroundingMode] = useState<'none' | 'search' | 'maps'>('none');
  const [includeTelemetry, setIncludeTelemetry] = useState(true);
  const [chatInput, setChatInput] = useState('');
  const [chatAttachment, setChatAttachment] = useState<{
    base64: string;
    mimeType: string;
    name: string;
  } | null>(null);
  const [chatTurns, setChatTurns] = useState<LocalChatTurn[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  useEffect(() => {
    if (userUid && cloudMessages.length > 0 && chatTurns.length === 0) {
      setChatTurns(
        cloudMessages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          modelUsed: m.modelUsed,
          groundingMode: m.groundingMode,
          sources: m.sourceUrls.map((uri) => ({
            title: uri,
            uri,
            kind: m.groundingMode === 'maps' ? 'maps' : 'web',
          })),
          createdAtMs: m.createdAtMs,
        }))
      );
    }
  }, [userUid, cloudMessages, chatTurns.length]);

  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed || chatLoading) return;

    setChatError(null);
    const userTurnId = `u-${Date.now()}`;
    const userTurn: LocalChatTurn = {
      id: userTurnId,
      role: 'user',
      text: trimmed,
      modelUsed: chatModel,
      groundingMode,
      sources: [],
      createdAtMs: Date.now(),
    };
    setChatTurns((prev) => [...prev, userTurn]);
    setChatInput('');
    setChatLoading(true);

    if (userUid) {
      onSaveChatMessage({
        id: userTurnId,
        role: 'user',
        text: trimmed,
        modelUsed: chatModel,
        groundingMode,
        sourceUrls: [],
        createdAtMs: userTurn.createdAtMs,
      });
    }

    try {
      const historyPayload = chatTurns.slice(-12).map((t) => ({ role: t.role, text: t.text }));
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          history: historyPayload,
          model: chatModel,
          thinkingLevel,
          groundingMode,
          latLng:
            groundingMode === 'maps' && coords
              ? { latitude: coords.latitude, longitude: coords.longitude }
              : null,
          imageBase64: chatAttachment?.base64,
          mimeType: chatAttachment?.mimeType,
          systemContext: includeTelemetry ? telemetrySummary : undefined,
        }),
      });
      const data = (await res.json()) as {
        text?: string;
        model?: string;
        groundingMode?: 'none' | 'search' | 'maps';
        sources?: Array<{ title: string; uri: string; kind: 'web' | 'maps' }>;
        error?: string;
      };
      if (!res.ok) {
        setChatError(data.error || 'Chat request failed.');
        return;
      }
      const modelTurnId = `m-${Date.now()}`;
      const modelTurn: LocalChatTurn = {
        id: modelTurnId,
        role: 'model',
        text: data.text || '(Empty response)',
        modelUsed: data.model || chatModel,
        groundingMode: data.groundingMode || groundingMode,
        sources: Array.isArray(data.sources) ? data.sources : [],
        createdAtMs: Date.now(),
      };
      setChatTurns((prev) => [...prev, modelTurn]);
      setChatAttachment(null);

      if (userUid) {
        onSaveChatMessage({
          id: modelTurnId,
          role: 'model',
          text: modelTurn.text,
          modelUsed: modelTurn.modelUsed,
          groundingMode: modelTurn.groundingMode,
          sourceUrls: modelTurn.sources.map((s) => s.uri),
          createdAtMs: modelTurn.createdAtMs,
        });
      }
    } catch {
      setChatError('Network error communicating with Gemini chat endpoint.');
    } finally {
      setChatLoading(false);
    }
  };

  // --- Tab 2: Live Voice (gemini-3.8-live) & Audio Transcribe (gemini-3.5-transcribe) ---
  const [voiceName, setVoiceName] = useState<'Zephyr' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir'>(
    'Zephyr'
  );
  const [liveStatus, setLiveStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>(
    'idle'
  );
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveTranscripts, setLiveTranscripts] = useState<
    Array<{ id: string; speaker: 'You' | 'Gemini'; text: string }>
  >([]);
  const [liveNudgeText, setLiveNudgeText] = useState('');

  const liveWsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const clearScheduledPlayback = useCallback(() => {
    for (const src of scheduledSourcesRef.current) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already stopped sources
      }
    }
    scheduledSourcesRef.current = [];
    if (outputAudioCtxRef.current) {
      nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;
    } else {
      nextStartTimeRef.current = 0;
    }
  }, []);

  const stopLiveVoice = useCallback(() => {
    clearScheduledPlayback();
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      void inputAudioCtxRef.current.close().catch(() => {});
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      void outputAudioCtxRef.current.close().catch(() => {});
      outputAudioCtxRef.current = null;
    }
    if (liveWsRef.current) {
      liveWsRef.current.close();
      liveWsRef.current = null;
    }
    setLiveStatus('idle');
  }, [clearScheduledPlayback]);

  useEffect(() => {
    return () => {
      stopLiveVoice();
    };
  }, [stopLiveVoice]);

  const schedulePcmPlayback = useCallback((base64Audio: string) => {
    const outCtx = outputAudioCtxRef.current;
    if (!outCtx) return;
    if (outCtx.state === 'suspended') {
      void outCtx.resume();
    }
    const int16 = base64ToInt16(base64Audio);
    if (int16.length === 0) return;

    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i += 1) {
      float32[i] = int16[i] / 0x8000;
    }
    const audioBuffer = outCtx.createBuffer(1, float32.length, 24000);
    audioBuffer.copyToChannel(float32, 0);

    const source = outCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(outCtx.destination);

    const startTime = Math.max(outCtx.currentTime + 0.02, nextStartTimeRef.current);
    source.start(startTime);
    nextStartTimeRef.current = startTime + audioBuffer.duration;
    scheduledSourcesRef.current.push(source);
    source.onended = () => {
      scheduledSourcesRef.current = scheduledSourcesRef.current.filter((s) => s !== source);
    };
  }, []);

  const startLiveVoice = async () => {
    stopLiveVoice();
    setLiveError(null);
    setLiveStatus('connecting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      inputAudioCtxRef.current = inputCtx;
      outputAudioCtxRef.current = outputCtx;
      nextStartTimeRef.current = outputCtx.currentTime;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/live?voice=${encodeURIComponent(voiceName)}`);
      liveWsRef.current = ws;

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data)) as {
            ready?: boolean;
            audio?: string;
            inputTranscript?: string;
            outputTranscript?: string;
            interrupted?: boolean;
            error?: string;
          };
          if (msg.error) {
            setLiveError(msg.error);
            setLiveStatus('error');
            return;
          }
          if (msg.ready) {
            setLiveStatus('connected');
          }
          if (msg.interrupted) {
            clearScheduledPlayback();
          }
          if (msg.audio) {
            schedulePcmPlayback(msg.audio);
          }
          if (msg.inputTranscript) {
            setLiveTranscripts((prev) =>
              [...prev, { id: `in-${Date.now()}-${Math.random()}`, speaker: 'You' as const, text: msg.inputTranscript! }].slice(-20)
            );
          }
          if (msg.outputTranscript) {
            setLiveTranscripts((prev) =>
              [...prev, { id: `out-${Date.now()}-${Math.random()}`, speaker: 'Gemini' as const, text: msg.outputTranscript! }].slice(-20)
            );
          }
        } catch {
          // Ignore malformed live message
        }
      };

      ws.onerror = () => {
        setLiveError('Live voice WebSocket connection failed.');
        setLiveStatus('error');
      };

      ws.onclose = () => {
        setLiveStatus((prev) => (prev === 'error' ? 'error' : 'idle'));
      };

      const source = inputCtx.createMediaStreamSource(stream);
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      source.connect(processor);
      processor.connect(inputCtx.destination);

      processor.onaudioprocess = (e) => {
        const activeWs = liveWsRef.current;
        if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
        const base64Pcm = float32ToPcm16Base64(e.inputBuffer.getChannelData(0));
        activeWs.send(JSON.stringify({ audio: base64Pcm }));
      };
    } catch (err) {
      stopLiveVoice();
      setLiveError(
        err instanceof Error
          ? err.message
          : 'Microphone access denied or unavailable for Live Voice.'
      );
      setLiveStatus('error');
    }
  };

  // Pre-recorded audio transcription (`gemini-3.5-transcribe`)
  const [isRecordingClip, setIsRecordingClip] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const [transcribeLoading, setTranscribeLoading] = useState(false);
  const [transcriptResult, setTranscriptResult] = useState<string>('');
  const [transcribeError, setTranscribeError] = useState<string | null>(null);

  const runAudioTranscription = async (base64: string, mimeType: string) => {
    setTranscribeLoading(true);
    setTranscribeError(null);
    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: base64, mimeType }),
      });
      const data = (await res.json()) as { transcript?: string; error?: string };
      if (!res.ok) {
        setTranscribeError(data.error || 'Audio transcription failed.');
        return;
      }
      setTranscriptResult(data.transcript || '(No speech detected)');
      onLogAiSession('Audio Transcription', data.transcript || '', 'gemini-3.5-transcribe');
    } catch {
      setTranscribeError('Network error during audio transcription.');
    } finally {
      setTranscribeLoading(false);
    }
  };

  const handleToggleRecordClip = async () => {
    if (isRecordingClip && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecordingClip(false);
      return;
    }
    setTranscribeError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const reader = new FileReader();
        reader.onload = () => {
          const url = String(reader.result || '');
          const b64 = url.slice(url.indexOf(',') + 1);
          void runAudioTranscription(b64, blob.type || 'audio/webm');
        };
        reader.readAsDataURL(blob);
      };
      recorder.start();
      setIsRecordingClip(true);
    } catch (err) {
      setTranscribeError(
        err instanceof Error ? err.message : 'Microphone permission required to record audio.'
      );
    }
  };

  // --- Tab 3: Image Create & Edit ---
  const [imagePrompt, setImagePrompt] = useState('');
  const [imageModel, setImageModel] = useState<'gemini-3.1-flash-lite-image' | 'gemini-nano-banana-2.1'>(
    'gemini-3.1-flash-lite-image'
  );
  const [imageAspectRatio, setImageAspectRatio] = useState<'1:1' | '16:9' | '9:16' | '4:3' | '3:4'>(
    '16:9'
  );
  const [imageSize, setImageSize] = useState<'1K' | '2K'>('1K');
  const [imageUseSearch, setImageUseSearch] = useState(false);
  const [sourceEditImage, setSourceEditImage] = useState<{
    base64: string;
    mimeType: string;
    dataUrl: string;
    name: string;
  } | null>(null);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [generatedImageCaption, setGeneratedImageCaption] = useState<string>('');
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  const handleGenerateImage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!imagePrompt.trim() || imageLoading) return;
    setImageLoading(true);
    setImageError(null);
    try {
      const res = await fetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: imagePrompt.trim(),
          model: imageModel,
          aspectRatio: imageAspectRatio,
          imageSize,
          useSearch: imageUseSearch,
          imageBase64: sourceEditImage?.base64,
          mimeType: sourceEditImage?.mimeType,
        }),
      });
      const data = (await res.json()) as {
        imageUrl?: string;
        text?: string;
        model?: string;
        error?: string;
      };
      if (!res.ok) {
        setImageError(data.error || 'Image generation failed.');
        return;
      }
      setGeneratedImageUrl(data.imageUrl || null);
      setGeneratedImageCaption(data.text || '');
      onLogAiSession('Image Studio Output', imagePrompt.trim(), data.model || imageModel);
    } catch {
      setImageError('Network error while generating image.');
    } finally {
      setImageLoading(false);
    }
  };

  // --- Tab 4: Video (Omni Flash) & Music (Lyria 3) ---
  const [videoPrompt, setVideoPrompt] = useState('');
  const [videoAspect, setVideoAspect] = useState<'16:9' | '9:16'>('16:9');
  const [videoDuration, setVideoDuration] = useState<'5s' | '8s' | '10s'>('5s');
  const [videoRefImage, setVideoRefImage] = useState<{
    base64: string;
    mimeType: string;
    dataUrl: string;
    name: string;
  } | null>(null);
  const [generatedVideoUrl, setGeneratedVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);

  const [musicPrompt, setMusicPrompt] = useState('');
  const [musicModel, setMusicModel] = useState<'lyria-3-clip-preview' | 'lyria-3-pro-preview'>(
    'lyria-3-clip-preview'
  );
  const [generatedAudioUrl, setGeneratedAudioUrl] = useState<string | null>(null);
  const [generatedLyrics, setGeneratedLyrics] = useState<string>('');
  const [musicLoading, setMusicLoading] = useState(false);
  const [musicError, setMusicError] = useState<string | null>(null);

  const handleGenerateVideo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!videoPrompt.trim() || videoLoading) return;
    setVideoLoading(true);
    setVideoError(null);
    try {
      const res = await fetch('/api/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: videoPrompt.trim(),
          aspectRatio: videoAspect,
          duration: videoDuration,
          imageBase64: videoRefImage?.base64,
          mimeType: videoRefImage?.mimeType,
        }),
      });
      const data = (await res.json()) as {
        videoDataUrl?: string | null;
        videoUri?: string | null;
        error?: string;
      };
      if (!res.ok) {
        setVideoError(data.error || 'Video generation failed.');
        return;
      }
      setGeneratedVideoUrl(data.videoDataUrl || data.videoUri || null);
      onLogAiSession('Omni Video Generation', videoPrompt.trim(), 'gemini-omni-1.2-flash');
    } catch {
      setVideoError('Network error while generating video.');
    } finally {
      setVideoLoading(false);
    }
  };

  const handleGenerateMusic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!musicPrompt.trim() || musicLoading) return;
    setMusicLoading(true);
    setMusicError(null);
    try {
      const res = await fetch('/api/music', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: musicPrompt.trim(),
          model: musicModel,
        }),
      });
      const data = (await res.json()) as {
        audioDataUrl?: string;
        lyrics?: string;
        error?: string;
      };
      if (!res.ok) {
        setMusicError(data.error || 'Music generation failed.');
        return;
      }
      setGeneratedAudioUrl(data.audioDataUrl || null);
      setGeneratedLyrics(data.lyrics || '');
      onLogAiSession('Lyria Music Studio', musicPrompt.trim(), musicModel);
    } catch {
      setMusicError('Network error while generating music.');
    } finally {
      setMusicLoading(false);
    }
  };

  return (
    <section
      id="gemini-studio"
      className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-3xl p-4 sm:p-6 space-y-5 shadow-xs"
    >
      {/* Header & Studio Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-[#0B4FE6]" />
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white tracking-tight">
              GAZVA Multimodal AI Studio
            </h2>
          </div>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Search & Maps Grounding · Live 16k/24k Voice · Transcription · Image Edit · Video & Lyria Music
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl">
          {(
            [
              { id: 'chat', label: 'Chatbot & Grounding', icon: MessageSquare },
              { id: 'voice', label: 'Live Voice & Audio', icon: Mic },
              { id: 'image', label: 'Image Create/Edit', icon: ImageIcon },
              { id: 'media', label: 'Video & Music', icon: Film },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-xl transition-colors whitespace-nowrap min-h-[36px] cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-[#0B4FE6] text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* TAB 1: Chatbot & Grounding */}
      {activeTab === 'chat' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-xs">
            <label className="inline-flex items-center gap-1.5 font-medium text-slate-700">
              <span>Model:</span>
              <select
                value={chatModel}
                onChange={(e) => setChatModel(e.target.value as typeof chatModel)}
                className="px-2 py-1 rounded bg-white border border-slate-200 font-mono text-xs text-slate-900"
              >
                <option value="gemini-4-hydrogen">gemini-4-hydrogen (Free)</option>
                <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (Free)</option>
                <option value="gemini-4-neon">gemini-4-neon (Paid Key)</option>
                <option value="gemini-4-carbon">gemini-4-carbon (Paid Key)</option>
              </select>
            </label>

            {chatModel.startsWith('gemini-4-') && (
              <label className="inline-flex items-center gap-1.5 font-medium text-slate-700">
                <span>Thinking:</span>
                <select
                  value={thinkingLevel}
                  onChange={(e) => setThinkingLevel(e.target.value as typeof thinkingLevel)}
                  className="px-2 py-1 rounded bg-white border border-slate-200 font-mono text-xs text-slate-900"
                >
                  <option value="LOW">LOW</option>
                  <option value="MEDIUM">MEDIUM</option>
                  <option value="HIGH">HIGH</option>
                  {chatModel !== 'gemini-4-carbon' && <option value="XHIGH">XHIGH</option>}
                </select>
              </label>
            )}

            <div className="inline-flex items-center gap-1 bg-white border border-slate-200 rounded-md p-0.5">
              <button
                type="button"
                onClick={() => setGroundingMode('none')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer ${
                  groundingMode === 'none' ? 'bg-[#0B4FE6] text-white' : 'text-slate-600'
                }`}
              >
                Standard
              </button>
              <button
                type="button"
                onClick={() => setGroundingMode('search')}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer ${
                  groundingMode === 'search' ? 'bg-[#0B4FE6] text-white' : 'text-slate-600'
                }`}
              >
                <Globe className="w-3 h-3" />
                <span>Google Search</span>
              </button>
              <button
                type="button"
                onClick={() => setGroundingMode('maps')}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer ${
                  groundingMode === 'maps' ? 'bg-[#DC2626] text-white' : 'text-slate-600'
                }`}
              >
                <MapPin className="w-3 h-3" />
                <span>Maps Grounding</span>
              </button>
            </div>

            <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-700 ml-auto cursor-pointer">
              <input
                type="checkbox"
                checked={includeTelemetry}
                onChange={(e) => setIncludeTelemetry(e.target.checked)}
                className="rounded border-slate-300 accent-[#0B4FE6]"
              />
              <span>Inject Live Telemetry</span>
            </label>
          </div>

          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-slate-50/70 dark:bg-slate-950/60 p-3.5 h-72 overflow-y-auto space-y-2.5">
            {chatTurns.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-xs text-slate-500 dark:text-slate-400 px-4">
                <MessageSquare className="w-6 h-6 text-[#0B4FE6] mb-1.5" />
                <p className="font-semibold text-slate-700 dark:text-slate-200">
                  Ask GAZVA AI Copilot about live telemetry, nearby places (Maps Grounding), or web facts (Search Grounding).
                </p>
                <p className="text-[11px] text-slate-400 mt-1">
                  {userUid
                    ? 'Cloud chat sync active — messages save to your Firestore workspace.'
                    : 'Sign in with Google above to sync chat history across devices.'}
                </p>
              </div>
            ) : (
              chatTurns.map((turn) => (
                <div
                  key={turn.id}
                  className={`rounded-2xl p-3 text-xs sm:text-sm ${
                    turn.role === 'user'
                      ? 'bg-[#0B4FE6] text-white ml-8'
                      : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 mr-8'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-[10px] font-mono opacity-75 mb-1">
                    <span>
                      {turn.role === 'user'
                        ? 'OPERATOR'
                        : `${turn.modelUsed}${turn.groundingMode !== 'none' ? ` · ${turn.groundingMode.toUpperCase()}` : ''}`}
                    </span>
                    <span>
                      {new Date(turn.createdAtMs).toLocaleTimeString([], {
                        hour12: false,
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap leading-relaxed">{turn.text}</div>
                  {turn.sources.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-800 flex flex-wrap gap-1.5">
                      {turn.sources.map((src) => (
                        <a
                          key={src.uri}
                          href={src.uri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-[11px] font-medium text-[#0B4FE6] dark:text-blue-400 underline"
                        >
                          {src.kind === 'maps' ? (
                            <MapPin className="w-3 h-3 text-red-600" />
                          ) : (
                            <Globe className="w-3 h-3 text-sky-600" />
                          )}
                          <span className="truncate max-w-[200px]">{src.title}</span>
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {chatError && (
            <div className="px-3 py-2 rounded-2xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-200 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{chatError}</span>
            </div>
          )}

          <form onSubmit={handleSendChat} className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer min-h-[42px]">
              <Upload className="w-3.5 h-3.5" />
              <span>{chatAttachment ? chatAttachment.name.slice(0, 14) : 'Attach Pic'}</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const parsed = await fileToBase64Parts(file);
                  setChatAttachment({
                    base64: parsed.base64,
                    mimeType: parsed.mimeType,
                    name: file.name,
                  });
                }}
              />
            </label>
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={
                groundingMode === 'maps'
                  ? 'Ask about nearby hospitals, fuel stations, gates, or routes...'
                  : groundingMode === 'search'
                  ? 'Ask with live Google Search verification...'
                  : 'Ask GAZVA Copilot anything...'
              }
              className="flex-1 min-w-[200px] px-3.5 py-2 text-xs sm:text-sm bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-2xl text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B4FE6]/25 min-h-[42px]"
            />
            <button
              type="submit"
              disabled={!chatInput.trim() || chatLoading}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs sm:text-sm font-bold rounded-2xl bg-[#0B4FE6] hover:bg-[#1D4ED8] text-white min-h-[42px] cursor-pointer disabled:opacity-50"
            >
              {chatLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              <span>Send</span>
            </button>
          </form>
        </div>
      )}

      {/* TAB 2: Live Voice (16kHz -> 24kHz) & Pre-recorded Transcription */}
      {activeTab === 'voice' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Real-Time Live Voice */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/70 dark:bg-slate-900/50 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  Real-Time Voice Copilot (Live API)
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  gemini-3.8-live · 16kHz mic stream · 24kHz gapless playback
                </p>
              </div>
              <select
                value={voiceName}
                onChange={(e) => setVoiceName(e.target.value as typeof voiceName)}
                disabled={liveStatus === 'connected' || liveStatus === 'connecting'}
                aria-label="Live voice persona"
                className="px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono text-slate-800 dark:text-slate-200"
              >
                <option value="Zephyr">Zephyr</option>
                <option value="Kore">Kore</option>
                <option value="Puck">Puck</option>
                <option value="Charon">Charon</option>
                <option value="Fenrir">Fenrir</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              {liveStatus === 'connected' || liveStatus === 'connecting' ? (
                <button
                  type="button"
                  onClick={stopLiveVoice}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-[#DC2626] hover:bg-red-700 text-white text-xs font-semibold min-h-[40px] cursor-pointer"
                >
                  <MicOff className="w-4 h-4" />
                  <span>{liveStatus === 'connecting' ? 'Connecting...' : 'Disconnect Voice'}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startLiveVoice}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-[#0B4FE6] hover:bg-[#1D4ED8] text-white text-xs font-semibold min-h-[40px] cursor-pointer"
                >
                  <Mic className="w-4 h-4" />
                  <span>Start Live Voice</span>
                </button>
              )}

              <span
                className={`text-[11px] font-mono font-semibold px-2.5 py-1 rounded-xl ${
                  liveStatus === 'connected'
                    ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300'
                    : liveStatus === 'error'
                    ? 'bg-red-100 dark:bg-red-950/60 text-red-800 dark:text-red-300'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                {liveStatus.toUpperCase()}
              </span>
            </div>

            {liveStatus === 'connected' && (
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={liveNudgeText}
                  onChange={(e) => setLiveNudgeText(e.target.value)}
                  placeholder="Optional text prompt into live session..."
                  className="flex-1 px-3 py-1.5 text-xs bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (
                      liveNudgeText.trim() &&
                      liveWsRef.current?.readyState === WebSocket.OPEN
                    ) {
                      liveWsRef.current.send(JSON.stringify({ text: liveNudgeText.trim() }));
                      setLiveNudgeText('');
                    }
                  }}
                  className="px-3.5 py-1.5 rounded-xl bg-[#0B4FE6] text-white text-xs font-semibold cursor-pointer"
                >
                  Send
                </button>
              </div>
            )}

            {liveError && (
              <div className="p-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 text-xs text-red-800 dark:text-red-300">
                {liveError}
              </div>
            )}

            <div className="h-36 overflow-y-auto bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 space-y-1.5 text-xs">
              {liveTranscripts.length === 0 ? (
                <div className="text-slate-400 italic">
                  Start Live Voice and speak naturally — live input & Gemini response transcripts appear here.
                </div>
              ) : (
                liveTranscripts.map((t) => (
                  <div key={t.id}>
                    <span className="font-mono font-bold text-[#0B4FE6] dark:text-blue-400">{t.speaker}: </span>
                    <span className="text-slate-800 dark:text-slate-200">{t.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Audio Transcription (`gemini-3.5-transcribe`) */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/70 dark:bg-slate-900/50 space-y-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Audio File & Mic Clip Transcription
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                gemini-3.5-transcribe · Record short brief or upload MP3/WAV/WebM
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleToggleRecordClip}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-2xl text-xs font-semibold min-h-[40px] cursor-pointer ${
                  isRecordingClip
                    ? 'bg-[#DC2626] text-white'
                    : 'bg-[#0B4FE6] text-white hover:bg-[#1D4ED8]'
                }`}
              >
                {isRecordingClip ? <Square className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                <span>{isRecordingClip ? 'Stop & Transcribe' : 'Record Mic Clip'}</span>
              </button>

              <label className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200 min-h-[40px] cursor-pointer">
                <Upload className="w-3.5 h-3.5" />
                <span>Upload Audio File</span>
                <input
                  type="file"
                  accept="audio/*"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const parsed = await fileToBase64Parts(file);
                    void runAudioTranscription(parsed.base64, parsed.mimeType);
                  }}
                />
              </label>

              {transcribeLoading && (
                <span className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Transcribing...</span>
                </span>
              )}
            </div>

            {transcribeError && (
              <div className="p-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 text-xs text-red-800 dark:text-red-300">
                {transcribeError}
              </div>
            )}

            <div className="h-36 overflow-y-auto bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 text-xs text-slate-800 dark:text-slate-200 whitespace-pre-wrap">
              {transcriptResult || (
                <span className="text-slate-400 italic">
                  Transcribed speech from your microphone clip or uploaded audio appears here.
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: Image Create & Edit */}
      {activeTab === 'image' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 p-3 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-[11px] text-amber-900 dark:text-amber-200">
            <AlertCircle className="w-4 h-4 shrink-0 text-amber-700 dark:text-amber-400" />
            <span>
              Image generation models require a billing-enabled API key in <strong>Settings &gt; Secrets</strong>. If your current key is Free Tier only, upgrade your key in Secrets to render images.
            </span>
          </div>

          <form onSubmit={handleGenerateImage} className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select
                value={imageModel}
                onChange={(e) => setImageModel(e.target.value as typeof imageModel)}
                className="px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 font-mono text-xs text-slate-900 dark:text-white"
              >
                <option value="gemini-3.1-flash-lite-image">
                  gemini-3.1-flash-lite-image (Paid Key)
                </option>
                <option value="gemini-nano-banana-2.1">
                  gemini-nano-banana-2.1 (Paid Key · Search/2K)
                </option>
              </select>

              <select
                value={imageAspectRatio}
                onChange={(e) => setImageAspectRatio(e.target.value as typeof imageAspectRatio)}
                className="px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 font-mono text-xs text-slate-900 dark:text-white"
              >
                <option value="16:9">16:9</option>
                <option value="1:1">1:1</option>
                <option value="9:16">9:16</option>
                <option value="4:3">4:3</option>
                <option value="3:4">3:4</option>
              </select>

              {imageModel === 'gemini-nano-banana-2.1' && (
                <>
                  <select
                    value={imageSize}
                    onChange={(e) => setImageSize(e.target.value as typeof imageSize)}
                    className="px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 font-mono text-xs text-slate-900 dark:text-white"
                  >
                    <option value="1K">1K</option>
                    <option value="2K">2K</option>
                  </select>
                  <label className="inline-flex items-center gap-1 font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={imageUseSearch}
                      onChange={(e) => setImageUseSearch(e.target.checked)}
                    />
                    <span>Search Grounding</span>
                  </label>
                </>
              )}

              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-200 cursor-pointer ml-auto">
                <Upload className="w-3.5 h-3.5" />
                <span>
                  {sourceEditImage ? `Editing: ${sourceEditImage.name.slice(0, 14)}` : 'Upload Image to Edit'}
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const parsed = await fileToBase64Parts(file);
                    setSourceEditImage({ ...parsed, name: file.name });
                  }}
                />
              </label>
              {sourceEditImage && (
                <button
                  type="button"
                  onClick={() => setSourceEditImage(null)}
                  className="text-xs text-[#DC2626] font-semibold underline cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={imagePrompt}
                onChange={(e) => setImagePrompt(e.target.value)}
                placeholder={
                  sourceEditImage
                    ? 'Describe what to edit in the uploaded image...'
                    : 'Describe an image or tactical perimeter visual to generate...'
                }
                className="flex-1 min-w-[220px] px-3.5 py-2 text-xs sm:text-sm bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-2xl text-slate-900 dark:text-white"
              />
              <button
                type="submit"
                disabled={!imagePrompt.trim() || imageLoading}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-[#0B4FE6] hover:bg-[#1D4ED8] text-white text-xs sm:text-sm font-semibold min-h-[42px] cursor-pointer disabled:opacity-50"
              >
                {imageLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ImageIcon className="w-4 h-4" />
                )}
                <span>{sourceEditImage ? 'Edit Image' : 'Generate Image'}</span>
              </button>
            </div>
          </form>

          {imageError && (
            <div className="p-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 text-xs text-red-800 dark:text-red-300">
              {imageError}
            </div>
          )}

          {generatedImageUrl && (
            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-3 bg-slate-50 dark:bg-slate-900/50 space-y-2.5">
              <img
                src={generatedImageUrl}
                alt="Generated output"
                className="w-full max-h-80 object-contain rounded-xl bg-slate-900"
              />
              {generatedImageCaption && (
                <p className="text-xs text-slate-700 dark:text-slate-300">{generatedImageCaption}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={generatedImageUrl}
                  download={`gazva-image-${Date.now()}.png`}
                  className="px-3 py-1.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100"
                >
                  Download PNG
                </a>
                <button
                  type="button"
                  onClick={() => {
                    const comma = generatedImageUrl.indexOf(',');
                    const b64 = comma >= 0 ? generatedImageUrl.slice(comma + 1) : '';
                    const mime = generatedImageUrl.slice(5, generatedImageUrl.indexOf(';')) || 'image/png';
                    setVideoRefImage({
                      base64: b64,
                      mimeType: mime,
                      dataUrl: generatedImageUrl,
                      name: 'generated-frame.png',
                    });
                    setActiveTab('media');
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#DC2626] text-white text-xs font-semibold cursor-pointer"
                >
                  <Film className="w-3.5 h-3.5" />
                  <span>Animate in Video Tab</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: Video (Omni Flash) & Music (Lyria 3) */}
      {activeTab === 'media' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 p-3 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-[11px] text-amber-900 dark:text-amber-200">
            <AlertCircle className="w-4 h-4 shrink-0 text-amber-700 dark:text-amber-400" />
            <span>
              Omni Flash video and Lyria 3 music generation require a billing-enabled API key in <strong>Settings &gt; Secrets</strong>.
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Video Generation / Image Animation */}
            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/70 dark:bg-slate-900/50 space-y-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  Video & Animation (gemini-omni-1.2-flash)
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Text-to-video or animate an uploaded/generated image (Paid Key)
                </p>
              </div>

              <form onSubmit={handleGenerateVideo} className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <select
                    value={videoAspect}
                    onChange={(e) => setVideoAspect(e.target.value as '16:9' | '9:16')}
                    className="px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 font-mono text-slate-900 dark:text-white"
                  >
                    <option value="16:9">16:9</option>
                    <option value="9:16">9:16</option>
                  </select>
                  <select
                    value={videoDuration}
                    onChange={(e) => setVideoDuration(e.target.value as '5s' | '8s' | '10s')}
                    className="px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 font-mono text-slate-900 dark:text-white"
                  >
                    <option value="5s">5s (720p)</option>
                    <option value="8s">8s (720p)</option>
                    <option value="10s">10s (720p)</option>
                  </select>
                  <label className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 cursor-pointer ml-auto font-medium">
                    <Upload className="w-3.5 h-3.5" />
                    <span>{videoRefImage ? videoRefImage.name.slice(0, 12) : 'Start Frame'}</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      className="sr-only"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const parsed = await fileToBase64Parts(file);
                        setVideoRefImage({ ...parsed, name: file.name });
                      }}
                    />
                  </label>
                  {videoRefImage && (
                    <button
                      type="button"
                      onClick={() => setVideoRefImage(null)}
                      className="text-[#DC2626] underline text-xs cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>

                <textarea
                  rows={2}
                  value={videoPrompt}
                  onChange={(e) => setVideoPrompt(e.target.value)}
                  placeholder="Describe motion, camera angle, or scene animation..."
                  className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white"
                />

                <button
                  type="submit"
                  disabled={!videoPrompt.trim() || videoLoading}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-[#0B4FE6] hover:bg-[#1D4ED8] text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
                >
                  {videoLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Film className="w-3.5 h-3.5" />
                  )}
                  <span>{videoLoading ? 'Rendering Video (up to 2m)...' : 'Generate Video'}</span>
                </button>
              </form>

              {videoError && (
                <div className="p-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 text-xs text-red-800 dark:text-red-300">
                  {videoError}
                </div>
              )}

              {generatedVideoUrl && (
                <video
                  src={generatedVideoUrl}
                  controls
                  playsInline
                  className="w-full rounded-xl bg-black max-h-60"
                />
              )}
            </div>

            {/* Music Generation (`lyria-3-*`) */}
            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/70 dark:bg-slate-900/50 space-y-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">Music Studio (Lyria 3)</h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  lyria-3-clip-preview (30s) or lyria-3-pro-preview (Paid Key)
                </p>
              </div>

              <form onSubmit={handleGenerateMusic} className="space-y-2.5">
                <select
                  value={musicModel}
                  onChange={(e) => setMusicModel(e.target.value as typeof musicModel)}
                  className="px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 font-mono text-xs text-slate-900 dark:text-white"
                >
                  <option value="lyria-3-clip-preview">lyria-3-clip-preview (30s)</option>
                  <option value="lyria-3-pro-preview">lyria-3-pro-preview (Full Track)</option>
                </select>

                <textarea
                  rows={2}
                  value={musicPrompt}
                  onChange={(e) => setMusicPrompt(e.target.value)}
                  placeholder="Describe genre, tempo, instrumentation, or mood..."
                  className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white"
                />

                <button
                  type="submit"
                  disabled={!musicPrompt.trim() || musicLoading}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-[#DC2626] hover:bg-red-700 text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
                >
                  {musicLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Music className="w-3.5 h-3.5" />
                  )}
                  <span>{musicLoading ? 'Composing Audio...' : 'Generate Music'}</span>
                </button>
              </form>

              {musicError && (
                <div className="p-2.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 text-xs text-red-800 dark:text-red-300">
                  {musicError}
                </div>
              )}

              {generatedAudioUrl && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
                    <Volume2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>Generated Track</span>
                  </div>
                  <audio src={generatedAudioUrl} controls className="w-full" />
                  {generatedLyrics && (
                    <div className="p-2.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] text-slate-700 dark:text-slate-300 max-h-28 overflow-y-auto whitespace-pre-wrap">
                      {generatedLyrics}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
