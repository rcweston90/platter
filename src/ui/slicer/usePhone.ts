import { useSyncExternalStore } from 'react';

/** Below this the slicer shows one area at a time (Chop or Arrange) with a
 *  tab bar at the bottom, sized for thumbs. */
export const PHONE_QUERY = '(max-width: 700px)';
/** A finger, not a mouse: bigger hit areas, no hover-only controls, no
 *  HTML5 drag and drop (iOS Safari has none). */
export const TOUCH_QUERY = '(pointer: coarse)';

function media(query: string) {
  const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null;
  return {
    subscribe: (fn: () => void) => {
      mq?.addEventListener('change', fn);
      return () => mq?.removeEventListener('change', fn);
    },
    get: () => !!mq?.matches,
  };
}

const phone = media(PHONE_QUERY);
const touch = media(TOUCH_QUERY);

export const useIsPhone = () => useSyncExternalStore(phone.subscribe, phone.get, () => false);
export const useIsTouch = () => useSyncExternalStore(touch.subscribe, touch.get, () => false);
