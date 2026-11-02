import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * Height (px) the on-screen keyboard occupies at the bottom of the viewport,
 * so bottom-fixed actions (Continue / Verify) can be lifted above it.
 *
 * - Web (iOS Safari/WebView): `Keyboard` events never fire, so the overlap is
 *   derived from the VisualViewport API — the only reliable keyboard-aware
 *   signal iOS Safari exposes.
 * - Native: real Keyboard show/hide events.
 */
export function useKeyboardBottomInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const vv = (window as any).visualViewport;
      if (!vv) return undefined;
      const update = () => {
        // iOS Safari also scrolls the document when an input focuses; keep
        // the app pinned so the viewport math stays correct.
        if (window.scrollY > 0) window.scrollTo(0, 0);
        const overlap = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        setInset(overlap);
      };
      update();
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
      return () => {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      };
    }

    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e: any) => setInset(Math.round(e?.endCoordinates?.height ?? 0)),
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setInset(0),
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return inset;
}
