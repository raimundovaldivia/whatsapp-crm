import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildInboxLayout, inboxVisibleRange } from '../utils/inbox-conversations.mjs';

// Keep the full scroll range, but mount only the rows near the viewport.
// Measured heights support both conversation cards and message-search snippets.
export default function VirtualizedList({ items, renderItem, label = 'Conversaciones' }) {
  const containerRef = useRef(null);
  const heightsRef = useRef(new Map());
  const [measureVersion, setMeasureVersion] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const layout = useMemo(() => buildInboxLayout(items, heightsRef.current), [items, measureVersion]);
  const range = inboxVisibleRange(layout.offsets, viewport.top, viewport.height);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const update = () => setViewport(previous => {
      const top = container.scrollTop;
      const height = container.clientHeight || 600;
      return previous.top === top && previous.height === height ? previous : { top, height };
    });
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(container);
    return () => observer?.disconnect();
  }, []);

  // Filtering can shorten the list while the user is near its end.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const maxTop = Math.max(0, layout.totalHeight - container.clientHeight);
    if (container.scrollTop > maxTop) container.scrollTop = maxTop;
    setViewport(previous => previous.top === container.scrollTop
      ? previous : { ...previous, top: container.scrollTop });
  }, [layout.totalHeight]);

  function measure(key, height) {
    if (height > 0 && Math.abs((heightsRef.current.get(key) || 0) - height) > 0.5) {
      heightsRef.current.set(key, height);
      setMeasureVersion(version => version + 1);
    }
  }

  return (
    <div ref={containerRef} role="list" aria-label={label}
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowAnchor: 'none' }}
      onScroll={event => {
        const container = event.currentTarget;
        setViewport({ top: container.scrollTop, height: container.clientHeight || 600 });
      }}>
      <div style={{ position: 'relative', height: layout.totalHeight }}>
        {items.slice(range.start, range.end).map((item, index) => (
          <MeasuredRow key={item.key} itemKey={item.key} onMeasure={measure}
            top={layout.offsets[range.start + index]} position={range.start + index + 1} count={items.length}>
            {renderItem(item)}
          </MeasuredRow>
        ))}
      </div>
    </div>
  );
}

function MeasuredRow({ itemKey, onMeasure, top, position, count, children }) {
  const rowRef = useRef(null);
  const measureRef = useRef(onMeasure);
  measureRef.current = onMeasure;
  useLayoutEffect(() => {
    const row = rowRef.current;
    const update = () => measureRef.current(itemKey, row.getBoundingClientRect().height);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(row);
    return () => observer?.disconnect();
  }, [itemKey]);
  return (
    <div ref={rowRef} role="listitem" aria-posinset={position} aria-setsize={count}
      style={{ position: 'absolute', top, left: 0, right: 0 }}>
      {children}
    </div>
  );
}
