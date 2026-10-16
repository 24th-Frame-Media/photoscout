import { useEffect, useRef, useState } from 'react';

/**
 * An image that falls through to the next candidate when one fails to load.
 *
 * Ported from event-scout, where a merged event carries a picture from every listing behind it and the
 * first is quite often a dead one (signed CDN addresses expire). Here an event has one `imageUrl`, so
 * this is a single image that takes itself off the page rather than showing a broken box; `images` stays
 * a list so a source that gives more than one needs no change. Only the browser knows which addresses
 * still resolve, so the choice happens here.
 */
export default function EventImage({
  images, className, alt = '', onNone, eager = false,
}: {
  images: string[];
  className?: string;
  alt?: string;
  /** Called when every candidate has failed, for callers that show a placeholder. */
  onNone?: () => void;
  /** Skip lazy loading: for the picture at the top of an open event, which is on screen at once. */
  eager?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const key = images.join('|');

  // A different event may reuse this component instance.
  useEffect(() => setIndex(0), [key]);

  const src = images[index];
  // Held in a ref so a caller's inline callback does not re-fire the effect on every render.
  const onNoneRef = useRef(onNone);
  onNoneRef.current = onNone;
  useEffect(() => {
    if (!src && images.length > 0) onNoneRef.current?.();
  }, [src, images.length]);

  if (!src) return null;
  return (
    <img
      key={src}
      className={className}
      src={src}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      referrerPolicy="no-referrer"
      onError={() => setIndex((i) => i + 1)}
    />
  );
}
