export type UiSound = "navigate" | "open" | "send" | "receive" | "success";

const STORAGE_KEY = "covechat-ui-sounds";
let audioContext: AudioContext | undefined;

export function uiSoundsEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== "off";
}

export function setUiSoundsEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  if (enabled) playUiSound("success");
}

export function playUiSound(kind: UiSound): void {
  if (!uiSoundsEnabled() || typeof AudioContext === "undefined") return;
  try {
    audioContext ??= new AudioContext();
    const context = audioContext;
    const now = context.currentTime;
    const gain = context.createGain();
    const oscillator = context.createOscillator();
    const profiles: Record<UiSound, [number, number, number, OscillatorType]> = {
      navigate: [330, 410, 0.045, "sine"],
      open: [420, 520, 0.06, "sine"],
      send: [520, 760, 0.085, "sine"],
      receive: [660, 510, 0.1, "sine"],
      success: [440, 880, 0.12, "sine"],
    };
    const [start, end, duration, type] = profiles[kind];
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(start, now);
    oscillator.frequency.exponentialRampToValueAtTime(end, now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(kind === "receive" ? 0.035 : 0.025, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.01);
  } catch {
    // Browsers may refuse audio before the first user gesture; visual feedback still works.
  }
}
