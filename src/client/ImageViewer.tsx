/**
 * The image preview surface: fit-to-pane by default, wheel zoom (anchored
 * at the cursor), drag to pan while zoomed, double-click (or the toolbar's
 * reset button) back to fit. Wheel handling rides a NATIVE non-passive
 * listener — React's synthetic wheel is passive at the root, where
 * preventDefault is a no-op.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import clsx from 'clsx'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Zoom bounds (×). */
const MIN_SCALE = 0.25
const MAX_SCALE = 8

/** One zoom step of the toolbar buttons. */
const ZOOM_STEP = 1.25

interface Offset {
  x: number
  y: number
}

export function ImageViewer(props: { url: string; title: string }) {
  const { url, title } = props
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Live mirrors for the native wheel listener (stable closure, no re-bind).
  const stateRef = useRef({ scale, offset })
  stateRef.current = { scale, offset }

  const reset = useCallback((): void => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  /** Zoom around one viewport point (keeps that image point under the cursor). */
  const zoomAt = useCallback((anchor: Offset, factor: number): void => {
    setScale((currentScale) => {
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, currentScale * factor))
      if (nextScale <= 1) {
        setOffset({ x: 0, y: 0 })
        return nextScale
      }
      const ratio = nextScale / currentScale
      setOffset((currentOffset) => ({
        x: anchor.x - (anchor.x - currentOffset.x) * ratio,
        y: anchor.y - (anchor.y - currentOffset.y) * ratio,
      }))
      return nextScale
    })
  }, [])

  /** Zoom at the viewport center (the toolbar buttons). */
  const zoomCenter = useCallback((factor: number): void => {
    const wrap = wrapRef.current
    if (wrap === null) return
    const rect = wrap.getBoundingClientRect()
    zoomAt({ x: rect.width / 2, y: rect.height / 2 }, factor)
  }, [zoomAt])

  // Native wheel → zoom (non-passive so preventDefault actually cancels the
  // scroll); deltaMode normalization keeps trackpads and wheels consistent.
  useEffect(() => {
    const wrap = wrapRef.current
    if (wrap === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = wrap.getBoundingClientRect()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1
      const factor = Math.exp(-event.deltaY * unit * 0.0015)
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      zoomAt(anchor, factor)
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => { wrap.removeEventListener('wheel', onWheel) }
  }, [zoomAt])

  // Drag pan (only meaningful while zoomed; dragging at 100% is a no-op).
  const panRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || stateRef.current.scale <= 1) return
    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseX: stateRef.current.offset.x,
      baseY: stateRef.current.offset.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current
    if (pan === null) return
    setOffset({ x: pan.baseX + (event.clientX - pan.startX), y: pan.baseY + (event.clientY - pan.startY) })
  }
  const endPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (panRef.current === null) return
    panRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
  }

  const percent = Math.round(scale * 100)

  return (
    <div
      ref={wrapRef}
      className={clsx(css.editorImageWrap, css.editorImageZoomable, dragging && css.editorImagePanning)}
      onDoubleClick={reset}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      <img
        className={css.editorImage}
        src={url}
        alt={title}
        draggable={false}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
        }}
      />
      <div className={css.editorImageToolbar}>
        <button type="button" className={css.editorImageButton} aria-label={t('zoomOut')} title={t('zoomOut')} onClick={() => { zoomCenter(1 / ZOOM_STEP) }}>
          −
        </button>
        <span className={css.editorImagePercent}>{percent}%</span>
        <button type="button" className={css.editorImageButton} aria-label={t('zoomIn')} title={t('zoomIn')} onClick={() => { zoomCenter(ZOOM_STEP) }}>
          +
        </button>
        <button type="button" className={clsx(css.editorImageButton, css.editorImageReset)} aria-label={t('zoomReset')} title={t('zoomReset')} onClick={reset}>
          {t('zoomReset')}
        </button>
      </div>
    </div>
  )
}
