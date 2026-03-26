import { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useCallback } from 'preact/hooks';

interface Props {
  title: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
  onClose: () => void;
}

export function BottomSheet({ title, children, footer, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startY: number; currentY: number; dragging: boolean; fromHeader: boolean }>({ startY: 0, currentY: 0, dragging: false, fromHeader: false });
  const closedByBack = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const animateClose = useCallback(() => {
    if (panelRef.current) {
      panelRef.current.style.transition = 'transform 0.2s ease-out';
      panelRef.current.style.transform = 'translateY(100%)';
    }
    if (overlayRef.current) {
      overlayRef.current.style.transition = 'opacity 0.2s ease-out, backdrop-filter 0.2s ease-out, -webkit-backdrop-filter 0.2s ease-out';
      overlayRef.current.style.opacity = '0';
      overlayRef.current.style.backdropFilter = 'blur(0px)';
      overlayRef.current.style.webkitBackdropFilter = 'blur(0px)';
    }
    setTimeout(() => onCloseRef.current(), 200);
  }, []);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    history.pushState({ sheet: true }, '');
    const handlePopState = () => {
      closedByBack.current = true;
      animateClose();
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('popstate', handlePopState);
      if (!closedByBack.current && history.state?.sheet) history.back();
    };
  }, [animateClose]);

  const handleTouchStart = useCallback((e: TouchEvent, fromHeader = false) => {
    // Always record start position; decide whether to drag in touchmove
    dragState.current = { startY: e.touches[0].clientY, currentY: e.touches[0].clientY, dragging: false, fromHeader };
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    const ds = dragState.current;
    ds.currentY = e.touches[0].clientY;
    const dy = ds.currentY - ds.startY;

    // Start dragging only if pulling down; header/handle area bypasses scroll check
    if (!ds.dragging) {
      if (dy > 0) {
        const body = bodyRef.current;
        const atTop = !body || body.scrollTop <= 0;
        if (atTop || ds.fromHeader) {
          ds.dragging = true;
        }
      }
      if (!ds.dragging) return;
    }

    if (dy > 0 && panelRef.current) {
      panelRef.current.style.transform = `translateY(${dy}px)`;
      panelRef.current.style.transition = 'none';
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    const ds = dragState.current;
    if (!ds.dragging) return;
    ds.dragging = false;
    const dy = ds.currentY - ds.startY;
    if (dy > 120) {
      animateClose();
    } else if (panelRef.current) {
      panelRef.current.style.transition = 'transform 0.2s ease-out';
      panelRef.current.style.transform = '';
    }
  }, [animateClose]);

  return createPortal(
    <div ref={overlayRef} class="sheet-overlay" onClick={animateClose}>
      <div
        ref={panelRef}
        class="sheet-panel"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div class="sheet-handle" onTouchStart={(e) => { e.stopPropagation(); handleTouchStart(e as unknown as TouchEvent, true); }} />
        <div class="sheet-header" onTouchStart={(e) => { e.stopPropagation(); handleTouchStart(e as unknown as TouchEvent, true); }}>
          <div class="label">{title}</div>
        </div>
        <div ref={bodyRef} class="sheet-body">
          {children}
        </div>
        {footer && <div class="sheet-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
