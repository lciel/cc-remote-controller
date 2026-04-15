import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

export type DriveState = 'off' | 'listening' | 'processing' | 'speaking';

// Prefix added to prompts in drive mode
const DRIVE_PREFIX = '【ドライブモード】運転中で音声で聞いている。返答は1〜2文の日本語で短く。箇条書き・コードブロック・ファイル名の列挙は禁止。「〇〇しました」「〇〇できました」程度の結論だけを伝えて。詳細は不要。';

/**
 * Strip code blocks and format text for TTS readout.
 */
function formatForSpeech(text: string): string {
  let result = text.replace(/```[\s\S]*?```/g, '…コード省略…');
  result = result.replace(/`([^`]+)`/g, '$1');
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1');
  result = result.replace(/_([^_]+)_/g, '$1');
  result = result.replace(/^#{1,6}\s+/gm, '');
  result = result.replace(/^[-*]\s+/gm, '');
  result = result.replace(/^\d+\.\s+/gm, '');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent {
  error: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

interface UseDriveModeOptions {
  onSubmit: (prompt: string) => void;
  jobActive: boolean;
  latestAssistantText: string;
  /** Return true if the text was handled as a voice command (skip submission). */
  onCommand?: (text: string) => boolean;
}

export function useDriveMode({ onSubmit, jobActive, latestAssistantText, onCommand }: UseDriveModeOptions) {
  const [state, setState] = useState<DriveState>('off');
  const [transcript, setTranscript] = useState('');
  // Currently spoken chunk (replaced as each utterance starts)
  const [currentSpeechText, setCurrentSpeechText] = useState('');
  const [supported] = useState(() => !!(window.SpeechRecognition || window.webkitSpeechRecognition));

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  // Current recognition session's final text (overwritten within session)
  const pendingTextRef = useRef('');
  // Committed finals from prior sessions in the current listening burst
  const committedTextRef = useRef('');
  // Timer for delayed submission after browser VAD ends recognition
  const submitTimerRef = useRef<number>(0);
  // Text already queued for speech — used to compute streaming diff
  const spokenTextRef = useRef('');
  // Live counter of queued/in-progress utterances
  const activeUtterancesRef = useRef(0);
  // Mirror of jobActive prop for use inside utterance callbacks
  const jobActiveRef = useRef(false);
  const stateRef = useRef<DriveState>('off');
  const shouldRestartRef = useRef(false);
  const intentionalStopRef = useRef(false);
  // Wake lock sentinel to prevent screen sleep
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  // Grace period after VAD ends recognition before actually submitting
  const SUBMIT_DELAY = 3000;

  const acquireWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    try {
      const wl = await (navigator as unknown as {
        wakeLock: { request: (type: string) => Promise<{ release: () => Promise<void> }> }
      }).wakeLock.request('screen');
      wakeLockRef.current = wl;
    } catch { /* ignore */ }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try { await wakeLockRef.current.release(); } catch { /* ignore */ }
      wakeLockRef.current = null;
    }
  }, []);

  // Re-acquire wake lock when page becomes visible again (browser releases it on hide)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && stateRef.current !== 'off' && !wakeLockRef.current) {
        acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [acquireWakeLock]);

  useEffect(() => { stateRef.current = state; }, [state]);

  const stopListening = useCallback(() => {
    clearTimeout(submitTimerRef.current);
    intentionalStopRef.current = true;
    shouldRestartRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
  }, []);

  const submitCommitted = useCallback(() => {
    // Flush current session's pending into committed first
    if (pendingTextRef.current) {
      committedTextRef.current += pendingTextRef.current;
      pendingTextRef.current = '';
    }
    const text = committedTextRef.current.trim();
    if (!text) return false;
    committedTextRef.current = '';
    clearTimeout(submitTimerRef.current);

    // Try voice command first
    if (onCommand && onCommand(text)) {
      setTranscript('');
      return true;
    }

    intentionalStopRef.current = true;
    shouldRestartRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
    setState('processing');
    setTranscript('');
    onSubmit(DRIVE_PREFIX + '\n\n' + text);
    return true;
  }, [onSubmit, onCommand]);

  const startListening = useCallback(() => {
    if (!supported) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    if (recognitionRef.current) {
      intentionalStopRef.current = true;
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }

    const recognition = new SpeechRecognition();
    // Non-continuous: auto-stops after one utterance, firing onend.
    // Chrome Mobile's continuous mode repeatedly finalizes the same phrase,
    // which is unreliable. Non-continuous is cleaner: one utterance → one result.
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'ja-JP';
    recognitionRef.current = recognition;
    intentionalStopRef.current = false;
    shouldRestartRef.current = true;

    recognition.onresult = (e: SpeechRecognitionEvent) => {
      // New speech detected — cancel any pending submit timer (user is continuing)
      clearTimeout(submitTimerRef.current);

      let interim = '';
      let finalText = '';
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      // Overwrite (not append) within session — single utterance per recognition instance.
      if (finalText) {
        pendingTextRef.current = finalText;
      }
      const total = committedTextRef.current + (pendingTextRef.current || interim);
      setTranscript(total.trim());
    };

    recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'aborted') return;
      if (e.error === 'no-speech') return; // onend will handle restart
      console.error('Speech recognition error:', e.error);
    };

    recognition.onend = () => {
      recognitionRef.current = null;

      if (intentionalStopRef.current) {
        intentionalStopRef.current = false;
        return;
      }

      if (stateRef.current !== 'listening') return;

      // Commit this session's pending into accumulated text
      if (pendingTextRef.current) {
        committedTextRef.current += pendingTextRef.current;
        pendingTextRef.current = '';
      }

      if (committedTextRef.current.trim()) {
        // Start/refresh grace period for continuation. If user keeps talking,
        // onresult above will clear this timer; onend after silence will reinstate it.
        clearTimeout(submitTimerRef.current);
        submitTimerRef.current = window.setTimeout(() => {
          if (stateRef.current === 'listening' && committedTextRef.current.trim()) {
            submitCommitted();
          }
        }, SUBMIT_DELAY);
      }

      // Restart recognition to capture continuation
      if (shouldRestartRef.current) {
        setTimeout(() => {
          if (stateRef.current === 'listening') startListening();
        }, 150);
      }
    };

    try {
      recognition.start();
    } catch {
      // Already started — ignore
    }
    setState('listening');
  }, [supported, submitCommitted]);

  // Find index (exclusive) of last sentence-ending char in text, or -1 if none.
  const findLastSentenceEnd = (text: string): number => {
    for (let i = text.length - 1; i >= 0; i--) {
      const c = text[i];
      if (c === '。' || c === '！' || c === '？' || c === '.' || c === '!' || c === '?' || c === '\n') {
        return i + 1;
      }
    }
    return -1;
  };

  // Enqueue a chunk of text for TTS. Multiple calls queue up sequentially.
  const enqueueSpeak = useCallback((text: string) => {
    const speechText = formatForSpeech(text);
    if (!speechText) return;

    if (stateRef.current !== 'speaking') setState('speaking');
    activeUtterancesRef.current++;

    const utterance = new SpeechSynthesisUtterance(speechText);
    utterance.lang = 'ja-JP';
    utterance.rate = 1.2;

    utterance.onstart = () => {
      // Show this chunk while it plays — replaces previous chunk
      setCurrentSpeechText(speechText);
    };

    const handleDone = () => {
      activeUtterancesRef.current = Math.max(0, activeUtterancesRef.current - 1);
      if (activeUtterancesRef.current === 0 && stateRef.current === 'speaking') {
        if (!jobActiveRef.current) {
          // Queue drained AND job finished → resume listening
          setCurrentSpeechText('');
          setState('listening');
          startListening();
        } else {
          // Queue drained but Claude still working (tool calls etc) → show processing
          // Keep currentSpeechText so user can still read the last spoken chunk.
          setState('processing');
        }
      }
    };
    utterance.onend = handleDone;
    utterance.onerror = handleDone;

    speechSynthesis.speak(utterance);
  }, [startListening]);

  // Keep jobActiveRef in sync
  useEffect(() => { jobActiveRef.current = jobActive; }, [jobActive]);

  // Stream TTS: speak new content as it arrives, broken at sentence boundaries.
  const prevJobActive = useRef(jobActive);
  useEffect(() => {
    if (stateRef.current === 'off') {
      prevJobActive.current = jobActive;
      return;
    }

    // Job just started — baseline is existing text (do not re-read history)
    if (!prevJobActive.current && jobActive) {
      spokenTextRef.current = latestAssistantText;
    }

    // Compute unspoken diff
    let unspoken: string;
    if (latestAssistantText.startsWith(spokenTextRef.current)) {
      unspoken = latestAssistantText.slice(spokenTextRef.current.length);
    } else {
      // Text was replaced (new assistant message) — treat all as unspoken
      spokenTextRef.current = '';
      unspoken = latestAssistantText;
    }

    if (jobActive) {
      // Streaming: only speak up to last complete sentence
      const end = findLastSentenceEnd(unspoken);
      if (end > 0) {
        const chunk = unspoken.slice(0, end);
        spokenTextRef.current += chunk;
        enqueueSpeak(chunk);
      }
    } else if (prevJobActive.current && !jobActive) {
      // Job just finished — speak anything remaining
      if (unspoken.trim()) {
        spokenTextRef.current += unspoken;
        enqueueSpeak(unspoken);
      } else if (activeUtterancesRef.current === 0) {
        // Nothing to speak and queue empty → resume listening
        setState('listening');
        startListening();
      }
    }

    prevJobActive.current = jobActive;
  }, [jobActive, latestAssistantText, enqueueSpeak, startListening]);

  const toggle = useCallback(() => {
    if (stateRef.current === 'off') {
      acquireWakeLock();
      // Prime SpeechSynthesis while in user-gesture context (required on mobile)
      try {
        const prime = new SpeechSynthesisUtterance(' ');
        prime.volume = 0;
        prime.lang = 'ja-JP';
        speechSynthesis.speak(prime);
      } catch { /* ignore */ }
      pendingTextRef.current = '';
      committedTextRef.current = '';
      startListening();
    } else {
      releaseWakeLock();
      stopListening();
      speechSynthesis.cancel();
      pendingTextRef.current = '';
      committedTextRef.current = '';
      setState('off');
      setTranscript('');
      setCurrentSpeechText('');
    }
  }, [startListening, stopListening, acquireWakeLock, releaseWakeLock]);

  useEffect(() => {
    return () => {
      stopListening();
      speechSynthesis.cancel();
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, [stopListening]);

  return { state, transcript, currentSpeechText, toggle, supported };
}
