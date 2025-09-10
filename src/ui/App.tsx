// src/ui/App.tsx
import React, { useEffect, useRef, useState } from 'react'
import type { ViewerHandle, InitOptions } from '../viewer' // types only

type NamedPart = { name: string; index: number; num: number }

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null)
  const [handle, setHandle] = useState<ViewerHandle | null>(null)

  // UI state
  const [status, setStatus] = useState('Drop a .glb or pick a file to load…')
  const [exposure, setExposure] = useState(1.1)
  const [autoRotate, setAutoRotate] = useState(true)
  const [usdzHref, setUsdzHref] = useState('')

  // Named sections (derived from part names: “sec 1|se 2|section 3”)
  const [namedParts, setNamedParts] = useState<NamedPart[]>([])
  const [stage, setStage] = useState(0) // 0: assembled, 1: exploded, 2+: per-named-part

  // Wheel/swipe debouncing
  const wheelCooldown = useRef(false)
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const touchStartT = useRef<number>(0)

  // headline animation key
  const [headlineKey, setHeadlineKey] = useState(0)

  // ---------- init viewer
  useEffect(() => {
    if (!mountRef.current) return
    let cleanup = () => {}

    ;(async () => {
      const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (window.innerWidth < 820)
      const viewerModule = isMobile ? await import('../viewer.mobile') : await import('../viewer')
      const initViewer = viewerModule.initViewer as (el: HTMLElement, opts?: InitOptions) => Promise<ViewerHandle>
      const disposeViewer = viewerModule.disposeViewer as (h: ViewerHandle) => void

      const h = await initViewer(mountRef.current!, {
        showHDRIBackground: false,
        enableShadows: true,
        toneMappingExposure: exposure,
        bloomEnabled: true,   // ignored by mobile build (no-op)
        scrollScrub: false,
      })
      setHandle(h)

      const names = h.getPartNames?.() ?? []
      setNamedParts(parseNamedParts(names))

      h.setExplode(0)
      h.isolateIndex(null)
      h.setOrbitTargetTo(null)

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
    // kick headline transition
    setHeadlineKey(k => k + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, stage, namedParts])

  // ---------- pinch-to-zoom & wheel + swipe-vs-drag routing
  useEffect(() => {
    const host = mountRef.current
    if (!host || !handle) return

    let pinchStartDist = 0
    let pinchActive = false
    const dist = (t1: Touch, t2: Touch) => Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY)

    const onTouchStart = (e: TouchEvent) => {
      // don’t block OrbitControls — we only track, not preventDefault
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
        // pinch zoom should *override* orbit, so preventDefault here
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

        // Swipe detection (vertical)
        const V_THRESH = 44
        const ANGLE_DOMINANCE = 1.5 // |dy| must be 1.5x |dx|
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
  const loopIndex = (i: number) => (totalStages <= 0 ? 0 : (i % totalStages + totalStages) % totalStages)
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

  // loaders / DnD
  async function onPickGLB(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f || !handle) return
    setStatus('Loading model…')
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
    finally { e.target.value = '' }
  }

  function onDrop(ev: React.DragEvent<HTMLDivElement>) {
    ev.preventDefault()
    const file = ev.dataTransfer.files?.[0]; if (!file || !handle) return
    const name = file.name.toLowerCase()
    setStatus('Loading model…')
    if (name.endsWith('.glb') || name.endsWith('.gltf')) {
      handle.loadGLB(file).then(() => {
        const names = handle.getPartNames?.() ?? []
        setNamedParts(parseNamedParts(names))
        setStage(0)
        handle.setExplode(0)
        handle.isolateIndex(null)
        handle.setOrbitTargetTo(null)
        setStatus('Model loaded.')
      }).catch((err: unknown) => { console.error(err); setStatus('Failed to load model.') })
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

  // Android / Others: WebXR AR
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
    alert('AR not supported on this device.')
  }

  const total = Math.max(1, 2 + namedParts.length)
  const stageTitle = (i: number) => {
    if (i === 0) return 'Overview'
    if (i === 1) return 'Exploded View'
    const p = namedParts[i - 2]; return p ? p.name : `Section ${i + 1}`
  }

  // Stage copy (title + subtitle) with smooth change
  const { titleText, subText } = getStageCopy(stage, namedParts)

  return (
    <div className="app">
      {/* Scoped styles */}
      <style>{`
  /* === mobile dynamic viewport sizing === */
  :root { --app-vh: 100dvh; }
  @supports not (height: 100dvh) {
    :root { --app-vh: 100vh; }
  }

  html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; touch-action: none; }
  .viewer { position: fixed; inset: 0; height: var(--app-vh); }
  .canvas-overlay { position: absolute; inset: 0; z-index: 2; pointer-events: none; } /* default: don't block orbit */

  :root {
    --bg: #ffffff;
    --ink: #0b1220;
    --muted: #5b6373;
    --line: #e9eef5;
    --accent: #ff6a00;
    --accent-ink: #ffffff;
  }

  /* ===== Dock (desktop + mobile) ===== */
  .tool-dock {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(env(safe-area-inset-bottom) + 12px);
    z-index: 6;
    display: flex;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 18px;
    background: rgba(255,255,255,0.88);
    -webkit-backdrop-filter: saturate(180%) blur(18px);
    backdrop-filter: saturate(180%) blur(18px);
    border: 1px solid var(--line);
    box-shadow: 0 12px 40px rgba(0,0,0,0.12);
    animation: dock-slide-up 320ms cubic-bezier(.22,.9,.32,1.2);
    max-width: 520px;
    pointer-events: auto; /* interactive */
  }
  .dock-btn, .dock-link {
    appearance:none; border:1px solid var(--line); background:#fff; color: var(--ink);
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:6px; flex:1 1 0; min-width:0; text-decoration: none;
    padding: 10px 10px; border-radius: 12px; cursor:pointer;
    transition: transform .08s ease, box-shadow .15s ease, background .15s ease;
    -webkit-tap-highlight-color: transparent;
  }
  .dock-btn:hover, .dock-link:hover { box-shadow: 0 6px 16px rgba(0,0,0,.08) }
  .dock-btn:active, .dock-link:active { transform: scale(0.98) }
  .dock-btn svg, .dock-link svg { width:22px; height:22px; display:block; }
  .dock-label { font-size:12px; line-height:1; letter-spacing:.2px; white-space:nowrap; }

  .ar-primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .ar-primary svg { stroke: #fff; }

  @keyframes dock-slide-up { from { transform: translate(-50%, 22px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }

  /* ===== Stage rail on the right ===== */
  .stage-rail {
    position: absolute;
    right: 16px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    pointer-events: auto; /* interactive */
  }
  .nav-chip {
    cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    width: 34px; height: 34px; border-radius: 50%;
    border: 1px solid var(--line); background: #fff; color: var(--ink);
    transition: transform .08s ease, box-shadow .15s ease;
  }
  .nav-chip:hover { box-shadow: 0 6px 16px rgba(0,0,0,.08) }
  .nav-chip:active { transform: scale(0.98) }

  .dot {
    width: 10px; height: 10px; border-radius: 50%;
    border: 1px solid var(--line); background: #fff; opacity: .7; cursor: pointer;
    transition: opacity .15s ease, transform .08s ease, background .15s ease;
  }
  .dot.active { background: var(--ink); opacity: 1 }
  .dot:active { transform: scale(0.9) }

  /* ===== Header/HUD ===== */
  .overlay-topbar {
    position: absolute;
    top: 14px;
    left: 14px;
    right: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    z-index: 4;
    pointer-events: none; /* don’t block orbit */
  }
  .brand {
    font-weight: 700; color: var(--ink);
    background: rgba(255,255,255,0.9);
    border: 1px solid var(--line);
    padding: 6px 10px; border-radius: 999px;
  }

  .hud {
    position: absolute;
    top: 66px; /* hugs the top on mobile */
    left: 14px;
    right: 14px;
    max-width: min(720px, 90vw);
    z-index: 4;
    pointer-events: none; /* text never blocks orbit */
  }
  .eyebrow {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.18em; color: #a74a00;
    background: #fff0e6; display: inline-block; padding: 6px 10px;
    border-radius: 999px; border: 1px solid #ffd1b3;
  }
  .title {
    margin: 10px 0 6px;
    font-size: clamp(22px, 5.4vw, 56px);
    line-height: 1.06;
    text-wrap: balance;
  }
  .sub {
    color: var(--muted);
    font-size: clamp(13px, 1.6vw, 16px);
    max-width: 60ch;
  }

  /* Smooth headline change */
  .headline-anim {
    animation: fadeSlide 360ms ease both;
  }
  @keyframes fadeSlide {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (min-width: 900px) {
    .hud { top: 84px; left: 36px; right: auto }
    .title { font-size: clamp(32px, 4.6vw, 64px); }
  }

  @media (max-width: 768px) {
    .tool-dock { max-width: min(92vw, 560px); padding: 10px 12px; gap: 8px; }
    .dock-btn, .dock-link { padding: 8px 8px }
    .stage-rail { right: 10px }
  }

  /* Footer KPIs */
  .canvas-footer {
    position: absolute;
    bottom: calc(env(safe-area-inset-bottom) + 70px);
    left: 14px;
    display: flex; gap: 12px; flex-wrap: wrap;
    font-size: 12px; color: var(--muted);
    z-index: 4; pointer-events: none;
  }
`}</style>

      {/* Viewer */}
      <div
        className="viewer"
        ref={mountRef}
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        <div className="canvas-overlay">
          {/* Top brand */}
          <div className="overlay-topbar">
            <div className="brand"><span>Mattress</span></div>
          </div>

          {/* Headline (top; mobile-friendly). pointer-events: none so orbit works everywhere */}
          <div className="hud">
            <div className="eyebrow">Premium Mattress Experience</div>
            <div key={headlineKey} className="headline-anim">
              <h1 className="title">{titleText}</h1>
              <p className="sub">
                {subText}
                {/* Instruction line must remain unchanged */}
                {' '}• Pinch to zoom • Drag to orbit • Use wheel / swipe to move through stages.
              </p>
            </div>
          </div>

          {/* Right stage rail (arrows + dots) */}
          <div className="stage-rail">
            <button className="nav-chip" onClick={prevStage} aria-label="Previous">◀</button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
              {Array.from({ length: total }).map((_, i) => (
                <span
                  key={i}
                  className={`dot ${i === stage ? 'active' : ''}`}
                  title={stageTitle(i)}
                  onClick={() => setStage(i)}
                />
              ))}
            </div>
            <button className="nav-chip" onClick={nextStage} aria-label="Next">▶</button>
          </div>

          {/* Bottom Dock (interactive) */}
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
                handle?.setVisibleIndices?.(null)
                handle?.setOrbitTargetTo(null)
                setStage(0)
              }}
              aria-label="Reset"
            >
              <ResetIcon /><span className="dock-label">Reset</span>
            </button>

            {/* AR control */}
            {isiOS ? (
              <a
                className="dock-btn ar-primary"
                rel="ar"
                href={usdzHref || '/assets/bed.usdz'}  // use chosen USDZ if present
                aria-label="View in your room"
                style={{ position: 'relative', textDecoration: 'none' }}
              >
                {/* Invisible poster image required by Quick Look */}
                <img
                  src="/assets/poster.jpg"
                  alt=""
                  width={100}
                  height={100}
                  style={{ position: 'absolute', opacity: 0, width: 1, height: 1, pointerEvents: 'none' }}
                />
                <ArIcon /><span className="dock-label">View in AR</span>
              </a>
            ) : (
              <button className="dock-btn ar-primary" onClick={onClickViewInAR} aria-label="View in your room">
                <ArIcon /><span className="dock-label">View in AR</span>
              </button>
            )}
          </div>

          {/* Footer KPIs */}
          <div className="canvas-footer">
            <span><b>4.8★</b> / 12,000+ reviews</span>
            <span><b>7-zone</b> support</span>
            <span><b>ISO</b> certified foams</span>
          </div>
        </div>
      </div>

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
    </div>
  )
}

/* ——— stage copy helpers ——— */
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
    // map sec numbers to friendly labels
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

/* ——— icons ——— */
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
