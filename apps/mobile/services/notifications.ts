import { Platform } from 'react-native';

/**
 * Reusable event-notification layer.
 *
 * - Native (Expo dev build): `expo-notifications` local notifications with a
 *   default short system sound. The notification handler plays the sound and
 *   shows a banner whether the app is foregrounded or not; a dedicated Android
 *   channel keeps it professional and non-repeating.
 * - Web: Web Notifications API (when the browser permission is granted) plus a
 *   short WebAudio chime unlocked by the first user interaction. Browsers
 *   cannot receive anything while fully closed without a push/service-worker
 *   setup, which this product does not have — limitations are reported
 *   honestly by `initNotifications`.
 *
 * Deduping: callers pass a stable `tag`; the same tag is never notified twice
 * in one session, so duplicate socket deliveries stay silent.
 */

type WebWindow = Window & {
  Notification?: {
    new (title: string, opts?: NotificationOptions): Notification;
    permission: 'default' | 'granted' | 'denied';
    requestPermission(cb?: (p: string) => void): Promise<NotificationPermission> | Promise<string>;
  };
};

type ExpoNotifications = {
  setNotificationHandler(handler: {
    handleNotification: (n: any) => Promise<any>;
  }): void;
  setNotificationChannelAsync(id: string, opts: any): Promise<any>;
  scheduleNotificationAsync(n: any): Promise<string>;
  requestPermissionsAsync(): Promise<any>;
};

let expoNotif: ExpoNotifications | null = null;
let initialized = false;
let webAudioCtx: AudioContext | null = null;
let audioUnlocked = false;
const notifiedTags = new Set<string>();

export interface AppNotification {
  title: string;
  body?: string;
  /** Stable, event-unique key (e.g. `accepted:<tripId>`). Prevents duplicates. */
  tag: string;
}

async function loadExpoNotifications(): Promise<ExpoNotifications | null> {
  if (Platform.OS !== 'web') {
    try {
      const mod = await import('expo-notifications');
      return mod as unknown as ExpoNotifications;
    } catch (e) {
      console.warn('[Notifications] expo-notifications unavailable:', (e as Error).message);
      return null;
    }
  }
  return null;
}

/** Establish the platform plumbing. Called from role screens; safe to repeat. */
export async function initNotifications(): Promise<string[]> {
  if (initialized) return [];
  initialized = true;
  const limitations: string[] = [];

  if (Platform.OS === 'web') {
    const w = window as unknown as WebWindow;
    if (!w.Notification) {
      limitations.push('مرورگر شما از اعلان‌ها پشتیبانی نمی‌کند');
      return limitations;
    }
    // Audio readiness: created/resumed after the first user gesture so that a
    // chime can be played later without autoplay violation.
    const unlock = () => {
      try {
        if (!webAudioCtx) {
          const AC = window.AudioContext || (window as any).webkitAudioContext;
          if (AC) webAudioCtx = new AC();
        }
        webAudioCtx?.resume().catch(() => {});
        audioUnlocked = true;
      } catch {
        /* unsupported — silent degrade */
      }
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
    return limitations;
  }

  // Native: Expo local notifications.
  expoNotif = await loadExpoNotifications();
  if (!expoNotif) {
    limitations.push('اعلان در این نسخه نصب نشده است');
    return limitations;
  }
  try {
    expoNotif.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true, // short default system sound — no repeated/continuous audio
        shouldSetBadge: false,
      }),
    });
    if (Platform.OS === 'android') {
      await expoNotif.setNotificationChannelAsync('ride-events', {
        name: 'رویدادهای سفر',
        importance: 4 /* high — no max-priority continuous alarms */,
        enableVibrate: true,
        lockscreenVisibility: 1, // public enough for ETA, hides bodies when locked
      });
    }
    await expoNotif.requestPermissionsAsync();
  } catch (e) {
    console.warn('[Notifications] init failed:', (e as Error).message);
    limitations.push('دسترسی اعلان تأمین نشد');
  }
  return limitations;
}

/** Short WebAudio chime for the web build (never before a user unlock). */
function playWebChime(): void {
  if (Platform.OS !== 'web') return;
  try {
    if (!audioUnlocked) return; // browser autoplay policy: stay silent
    if (!webAudioCtx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      webAudioCtx = new AC();
    }
    const ctx = webAudioCtx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    [880, 1174.7].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.12);
      gain.gain.linearRampToValueAtTime(0.08, now + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.25);
    });
  } catch {
    /* no audio — degrade silently */
  }
}

/**
 * Fire an event notification. Fire-and-forget; never blocks ride logic.
 * Duplicate tags are dropped (same event delivered twice stays silent).
 */
export function notifyEvent(n: AppNotification): void {
  if (notifiedTags.has(n.tag)) return;
  notifiedTags.add(n.tag);

  if (Platform.OS === 'web') {
    playWebChime();
    const w = window as unknown as WebWindow;
    if (w.Notification?.permission === 'granted') {
      try {
        new w.Notification(n.title, { body: n.body || '', dir: 'rtl', lang: 'fa', tag: n.tag });
      } catch {
        /* permission edge cases degrade silently */
      }
    }
    return;
  }

  if (!expoNotif) return;
  // Small delay so a screen transition never clips the banner scheduling.
  setTimeout(() => {
    expoNotif!
      .scheduleNotificationAsync({
        // channel stays grouped on one professional channel on Android
        content: { title: n.title, body: n.body || '', sound: true },
        trigger: null,
      })
      .catch((e) => console.warn('[Notifications] schedule failed:', (e as Error).message));
  }, 50);
}

export function webNotificationsSupported(): boolean {
  if (Platform.OS !== 'web') return false;
  return !!(window as unknown as WebWindow).Notification;
}

/** Browser permission — call from a user-facing surface if desired. */
export async function requestWebNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'web') return false;
  const w = window as unknown as WebWindow;
  if (!w.Notification) return false;
  if (w.Notification.permission === 'granted') return true;
  if (w.Notification.permission === 'denied') return false;
  const res = await w.Notification.requestPermission();
  return res === 'granted';
}
