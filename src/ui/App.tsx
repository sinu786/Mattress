// src/ui/App.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ViewerHandle, InitOptions } from '../viewer.ts'
import './app.css'

type NamedPart = { name: string; index: number; num: number }

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null)
  const [handle, setHandle] = useState<ViewerHandle | null>(null)

  // UI state
  const [status, setStatus] = useState('Drop a .glb or pick a file to load…')
  const [exposure, setExposure] = useState(1.1)
  const [autoRotate, setAutoRotate] = useState(true)
  const [usdzHref, setUsdzHref] = useState('')

  // Loading/boot states
  const [booting, setBooting] = useState(true)
  const [modelLoading, setModelLoading] = useState(false)
  const [loadPct, setLoadPct] = useState<number | null>(null)
  const progTimer = useRef<number | null>(null)

  // Named sections (derived from part names: “sec 1|se 2|section 3”)
  const [namedParts, setNamedParts] = useState<NamedPart[]>([])
  const [stage, setStage] = useState(0) // 0: assembled, 1: exploded, 2+: per-named-part

  // Wheel/swipe debouncing
  const wheelCooldown = useRef(false)
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const touchStartT = useRef<number>(0)

  // headline animation key
  const [headlineKey, setHeadlineKey] = useState(0)

  // mobile + AR helpers
  const [isMobile, setIsMobile] = useState(false)
  const quickLookRef = useRef<HTMLAnchorElement>(null)

  // ---------- init viewer
  useEffect(() => {
    if (!mountRef.current) return
    let cleanup = () => {}

    ;(async () => {
      const isMobileUA =
        /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (window.innerWidth < 820)
      setIsMobile(isMobileUA)

      const viewerModule = isMobileUA
        ? await import('../viewer')
        : await import('../viewer')
      const initViewer = viewerModule.initViewer as (
        el: HTMLElement,
        opts?: InitOptions
      ) => Promise<ViewerHandle>
      const disposeViewer = viewerModule.disposeViewer as (h: ViewerHandle) => void

      setBooting(true)

      const h = await initViewer(mountRef.current!, {
        showHDRIBackground: false,
        enableShadows: true,
        toneMappingExposure: exposure,
        bloomEnabled: true,
        scrollScrub: false,
      })
      setHandle(h)

      const names = h.getPartNames?.() ?? []
      setNamedParts(parseNamedParts(names))

      h.setExplode(0)
      h.isolateIndex(null)
      h.setOrbitTargetTo(null)

      requestAnimationFrame(() => {
        setTimeout(() => setBooting(false), 120)
      })

      cleanup = () => disposeViewer(h)
    })()

    return () => cleanup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // reactive controls
  useEffect(() => { handle?.setExposure(exposure) }, [exposure, handle])
  useEffect(() => { handle?.setAutoRotate(autoRotate) }, [autoRotate, handle])

  // apply current stage
  useEffect(() => {
    if (!handle) return
    applyStage(handle, stage, namedParts)
    // Force headline remount + animation
    setHeadlineKey(k => k + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, stage, namedParts])

  // ---------- pinch-to-zoom & wheel + swipe-vs-drag routing
  useEffect(() => {
    const host = mountRef.current
    if (!host || !handle) return

    let pinchStartDist = 0
    let pinchActive = false
    const dist = (t1: Touch, t2: Touch) =>
      Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY)

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchActive = true
        pinchStartDist = dist(e.touches[0], e.touches[1])
      } else if (e.touches.length === 1) {
        touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
        touchStartT.current = performance.now()
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (pinchActive && e.touches.length === 2) {
        e.preventDefault()
        const d = dist(e.touches[0], e.touches[1])
        if (pinchStartDist > 0) {
          const scale = d / pinchStartDist
          const factor = 1 / Math.max(0.2, Math.min(5, scale))
          handle.dolly?.(factor)
        }
        pinchStartDist = d
      }
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (pinchActive && e.touches.length < 2) {
        pinchActive = false
        pinchStartDist = 0
      }
      const start = touchStart.current
      if (start) {
        const endX = e.changedTouches?.[0]?.clientX ?? start.x
        const endY = e.changedTouches?.[0]?.clientY ?? start.y
        const dx = endX - start.x
        const dy = endY - start.y
        const dt = performance.now() - touchStartT.current
        const absX = Math.abs(dx), absY = Math.abs(dy)

        // vertical swipe to change stage
        const V_THRESH = 44
        const ANGLE_DOMINANCE = 1.5
        const TIME_MAX = 600

        if (absY > V_THRESH && absY > ANGLE_DOMINANCE * absX && dt < TIME_MAX) {
          if (dy < 0) nextStage()
          else prevStage()
        }
      }
      touchStart.current = null
    }

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const k = Math.exp((e.deltaY / 100) * 0.15)
        handle.dolly?.(k)
      } else {
        if (wheelCooldown.current) return
        if (Math.abs(e.deltaY) < 30) return
        e.preventDefault()
        wheelCooldown.current = true
        if (e.deltaY > 0) nextStage()
        else prevStage()
        window.setTimeout(() => { wheelCooldown.current = false }, 260)
      }
    }

    host.addEventListener('touchstart', onTouchStart, { passive: true })
    host.addEventListener('touchmove', onTouchMove, { passive: false })
    host.addEventListener('touchend', onTouchEnd, { passive: true })
    host.addEventListener('touchcancel', onTouchEnd, { passive: true })
    host.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      host.removeEventListener('touchstart', onTouchStart as any)
      host.removeEventListener('touchmove', onTouchMove as any)
      host.removeEventListener('touchend', onTouchEnd as any)
      host.removeEventListener('touchcancel', onTouchEnd as any)
      host.removeEventListener('wheel', onWheel as any)
    }
  }, [handle])

  // ---------- helpers
  function parseNamedParts(allNames: string[]): NamedPart[] {
    const rx = /^(?:\s*(?:sec|se|section)\s*)(\d+)\s*$/i
    const picks: NamedPart[] = []
    allNames.forEach((name, idx) => {
      const m = rx.exec((name || '').trim())
      if (!m) return
      const num = parseInt(m[1], 10)
      if (Number.isFinite(num)) picks.push({ name, index: idx, num })
    })
    picks.sort((a, b) => a.num - b.num)
    return picks
  }

  const totalStages = 2 + namedParts.length
  const loopIndex = (i: number) =>
    (totalStages <= 0 ? 0 : (i % totalStages + totalStages) % totalStages)
  const nextStage = () => setStage(s => loopIndex(s + 1))
  const prevStage = () => setStage(s => loopIndex(s - 1))

  function applyStage(h: ViewerHandle, idx: number, parts: NamedPart[]) {
    if (idx === 0) {
      h.setExplode(0)
      h.isolateIndex(null)
      h.setOrbitTargetTo(null)
      return
    }
    if (idx === 1) {
      h.setExplode(1)
      h.isolateIndex(null)
      h.setOrbitTargetTo(null)
      return
    }
    const p = parts[idx - 2]
    if (p) {
      h.setExplode(1)
      h.isolateIndex(p.index, 0.22)
      h.setOrbitTargetByName(p.name)
    }
  }

  // --- Loading bar helpers
  function startProgress(indeterminate = true) {
    setModelLoading(true)
    setLoadPct(indeterminate ? null : 0)
    if (progTimer.current) {
      window.clearInterval(progTimer.current)
      progTimer.current = null
    }
    let p = 0
    progTimer.current = window.setInterval(() => {
      p = Math.min(90, p + 2 + Math.random() * 6)
      setLoadPct(prev => (prev === null ? null : p))
    }, 120) as unknown as number
  }
  function finishProgress() {
    if (progTimer.current) {
      window.clearInterval(progTimer.current)
      progTimer.current = null
    }
    setLoadPct(prev => (prev === null ? null : 100))
    setTimeout(() => {
      setModelLoading(false)
      setLoadPct(null)
    }, 260)
  }

  // loaders / DnD
  async function onPickGLB(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f || !handle) return
    setStatus('Loading model…')
    startProgress(true)
    try {
      await handle.loadGLB(f)
      const names = handle.getPartNames?.() ?? []
      setNamedParts(parseNamedParts(names))
      setStage(0)
      handle.setExplode(0)
      handle?.isolateIndex(null)
      handle.setOrbitTargetTo(null)
      setStatus('Model loaded.')
    } catch (err: unknown) { console.error(err); setStatus('Failed to load model.') }
    finally { e.target.value = ''; finishProgress() }
  }

  function onDrop(ev: React.DragEvent<HTMLDivElement>) {
    ev.preventDefault()
    const file = ev.dataTransfer.files?.[0]; if (!file || !handle) return
    const name = file.name.toLowerCase()
    setStatus('Loading model…')

    if (name.endsWith('.glb') || name.endsWith('.gltf')) {
      startProgress(true)
      handle.loadGLB(file).then(() => {
        const names = handle.getPartNames?.() ?? []
        setNamedParts(parseNamedParts(names))
        setStage(0)
        handle.setExplode(0)
        handle.isolateIndex(null)
        handle.setOrbitTargetTo(null)
        setStatus('Model loaded.')
      }).catch((err: unknown) => { console.error(err); setStatus('Failed to load model.') })
        .finally(() => finishProgress())
    } else if (name.endsWith('.usdz')) {
      const url = URL.createObjectURL(file); setUsdzHref(url); setStatus('USDZ ready for iOS Quick Look.')
    } else setStatus('Unsupported file. Drop a .glb/.gltf or .usdz.')
  }

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => e.preventDefault()
  const onPickUSDZ = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    setUsdzHref(URL.createObjectURL(f)); e.target.value = ''; setStatus('USDZ ready for iOS Quick Look.')
  }

  // iOS detection
  const isiOS = typeof navigator !== 'undefined' &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1))

  // WebXR-first; fallback to Quick Look on iOS
  const onClickViewInAR = async () => {
    try {
      const xr = (navigator as any).xr
      if (xr?.isSessionSupported) {
        const supported = await xr.isSessionSupported('immersive-ar')
        if (supported) {
          await handle?.enterAR?.()
          return
        }
      }
    } catch {}
    if (isiOS && quickLookRef.current) {
      quickLookRef.current.click()
      return
    }
    alert('AR not supported on this device/browser.')
  }

  const stageTitle = (i: number) => {
    if (i === 0) return 'Overview'
    if (i === 1) return 'Exploded View'
    const p = namedParts[i - 2]; return p ? p.name : `Section ${i + 1}`
  }

  // Stage copy
  const { titleText, subText } = getStageCopy(stage, namedParts)
  const showLoading = booting || modelLoading

  return (
    <div className="app-root">
      {/* Viewer */}
      <div
        className="viewer"
        ref={mountRef}
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        <div className="canvas-overlay">
          {/* Top-right brand */}
          <div className="overlay-topbar">
          </div>

          {/* Headline (left) */}
          <div className="hud">
            <div className="eyebrow">Premium Mattress Experience</div>
            <div key={`headline-${stage}-${headlineKey}`} className="headline-anim">
              <h1 className="title">{titleText}</h1>
              <p className="sub">
                {subText}
                {' '}• Pinch to zoom • Drag to orbit • Wheel / swipe to change stages.
              </p>
            </div>
          </div>

          {/* Bottom Dock — desktop + mobile */}
          <div className="tool-dock">
            <button className="dock-btn" onClick={() => setStage(0)} aria-label="Overview">
              <OverviewIcon /><span className="dock-label">Overview</span>
            </button>
            <button className="dock-btn" onClick={() => setStage(1)} aria-label="Exploded">
              <ExplodedIcon /><span className="dock-label">Exploded</span>
            </button>
            <button
              className="dock-btn"
              onClick={() => {
                handle?.setExplode(0)
                handle?.isolateIndex?.(null)
                handle?.setOrbitTargetTo(null)
                setStage(0)
              }}
              aria-label="Reset"
            >
              <ResetIcon /><span className="dock-label">Reset</span>
            </button>
            <button className="dock-btn primary" onClick={onClickViewInAR} aria-label="View in AR">
              <ArIcon /><span className="dock-label">View in AR</span>
            </button>
          </div>
        </div>
      </div>

      {/* Loading Scrim */}
      {showLoading && (
        <div className="loading-scrim" aria-busy="true" aria-live="polite">
          <div className="loading-card">
            <div className="loading-title">
              {booting ? 'Loading app' : (status || 'Loading model…')}
            </div>
            <div className="progress" data-indeterminate={loadPct === null || Number.isNaN(loadPct) ? 'true' : 'false'}>
              <div
                className="progress-fill"
                style={{ width: loadPct && loadPct > 0 ? `${Math.min(100, loadPct)}%` : '0%' }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Hidden utilities */}
      <div style={{ display: 'none' }}>
        <div className="row">
          <label htmlFor="glb">Load GLB:</label>
          <input id="glb" type="file" accept=".glb,.gltf" onChange={onPickGLB} />
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <label htmlFor="usdz">iOS USDZ:</label>
          <input id="usdz" type="file" accept=".usdz" onChange={onPickUSDZ} />
        </div>
        <div className="muted">{status}</div>
      </div>

      {/* iOS Quick Look fallback anchor */}
      <a
        ref={quickLookRef}
        rel="ar"
        href={usdzHref || '/assets/bed.usdz'}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        aria-hidden="true"
      >
        <img src="/assets/poster.jpg" alt="" width={1} height={1} />
      </a>
    </div>
  )
}

/* —— stage copy helpers —— */
function getStageCopy(stage: number, parts: NamedPart[]) {
  // Defaults
  let titleText = 'Feel the Bed. Before You Buy.'
  let subText = 'Explore every layer in 3D'

  if (stage === 0) {
    titleText = 'Meet your next mattress'
    subText = 'Spin, zoom, and inspect the design'
  } else if (stage === 1) {
    titleText = 'Layer-by-layer clarity'
    subText = 'See how each component works together'
  } else {
    const p = parts[stage - 2]
    const secNum = p?.num
    switch (secNum) {
      case 1:
        titleText = 'Cloud-soft, breathable comfort'
        subText = 'The fluffy surface welcomes you with instant pressure relief'
        break
      case 2:
        titleText = 'Adaptive support foam'
        subText = 'Contours to you while keeping your spine aligned'
        break
      case 3:
        titleText = 'Heat dispersion technology'
        subText = 'Graphite channels and airflow paths draw heat away'
        break
      case 4:
        titleText = 'Individually tuned springs'
        subText = 'Active lift with motion isolation across the bed'
        break
      default:
        titleText = p?.name ?? 'Section'
        subText = 'Focus on this layer'
        break
    }
  }
  return { titleText, subText }
}

/* —— icons —— */
function OverviewIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8M12 8v8" />
    </svg>
  )
}
function ExplodedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12h7M14 12h7" />
      <path d="M12 3v7M12 14v7" />
      <circle cx="12" cy="12" r="1.5" />
    </svg>
  )
}
function ResetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.5 15a9 9 0 1 0 .5-5" />
    </svg>
  )
}
function ArIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  )
}
