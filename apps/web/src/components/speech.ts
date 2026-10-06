import {useCallback, useEffect, useRef, useState} from 'react';

type SpeechResult = {transcript: string; isFinal: boolean};
type SpeechRecognitionLike = {lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; abort(): void; onresult: ((event: {results: ArrayLike<ArrayLike<SpeechResult> & {isFinal: boolean}>}) => void) | null; onerror: ((event: {error: string}) => void) | null; onend: (() => void) | null};
const Recognition = (globalThis as unknown as {SpeechRecognition?: new () => SpeechRecognitionLike}).SpeechRecognition
  ?? (globalThis as unknown as {webkitSpeechRecognition?: new () => SpeechRecognitionLike}).webkitSpeechRecognition;
export const speechSupported = Boolean(Recognition);

/** Browser speech recognition (Web Speech API): interim text while speaking, one final callback at the end. */
export function useSpeech({onInterim, onFinal, onError}: {onInterim?: (text: string) => void; onFinal: (text: string) => void; onError?: (message: string) => void}) {
  const [listening, setListening] = useState(false);
  const engine = useRef<SpeechRecognitionLike | null>(null);
  const handlers = useRef({onInterim, onFinal, onError});
  handlers.current = {onInterim, onFinal, onError};
  useEffect(() => () => engine.current?.abort(), []);

  const toggle = useCallback(() => {
    if (!Recognition) return;
    if (engine.current && listening) { engine.current.stop(); return; }
    const recognition = new Recognition();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    let finalText = '';
    recognition.onresult = event => {
      const transcript = Array.from(event.results).map(result => result[0].transcript).join(' ');
      handlers.current.onInterim?.(transcript);
      if (event.results[event.results.length - 1].isFinal) finalText = transcript;
    };
    recognition.onerror = event => { if (event.error !== 'aborted' && event.error !== 'no-speech') handlers.current.onError?.(event.error === 'not-allowed' ? 'Microphone access was blocked. Allow it in the browser to dictate.' : `Voice input stopped: ${event.error}`); };
    recognition.onend = () => { setListening(false); engine.current = null; if (finalText) handlers.current.onFinal(finalText); };
    engine.current = recognition;
    setListening(true);
    recognition.start();
  }, [listening]);

  const cancel = useCallback(() => { engine.current?.abort(); engine.current = null; setListening(false); }, []);
  return {listening, toggle, cancel, supported: speechSupported};
}
