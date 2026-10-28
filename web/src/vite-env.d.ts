/// <reference types="vite/client" />

interface Window {
  PhotoScoutNative?: {
    isNative?: boolean;
    platform?: 'android' | 'ios';
    version?: string;
    startBackgroundLocation?: () => void;
    stopBackgroundLocation?: () => void;
    setKeepAwake?: (awake: boolean) => void;
    openServerSettings?: () => void;
    vibrate?: (ms?: number) => void;
  };
}
