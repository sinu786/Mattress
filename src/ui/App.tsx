  // src/ui/App.tsx
  import React, { useEffect, useMemo, useRef, useState } from 'react'
  import type { ViewerHandle, InitOptions } from '../viewer'

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
    const [booting, setBooting] = useState(true)            // viewer init blur
    const [modelLoading, setModelLoading] = useState(false) // GLB load blur
    const [loadPct, setLoadPct] = useState<number | null>(null) // null = indeterminate
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
          ? await import('../viewer.mobile')
          : await import('../viewer')
        const initViewer = viewerModule.initViewer as (
          el: HTMLElement,
          opts?: InitOptions
        ) => Promise<ViewerHandle>
        const disposeViewer = viewerModule.disposeViewer as (h: ViewerHandle) => void

        // show boot blur immediately
        setBooting(true)

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

        // allow one paint before removing boot blur for a nicer feel
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
          // pinch zoom should override orbit
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

    // --- Loading bar helpers (simulated progress until Promise resolves)
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

    // Android/iOS: WebXR-first; fallback to Quick Look on iOS
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
      } catch {
        // ignore and try fallback
      }

      // iOS Quick Look fallback (anchor must exist in DOM)
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

    // Stage copy (title + subtitle) with smooth change
    const { titleText, subText } = getStageCopy(stage, namedParts)

    const showLoading = booting || modelLoading

    return (
      <div className="app">
        {/* Scoped styles */}
        <style>{`

        :root{
  /* — colors — */
  --bg:          #0b0f17;          /* deep slate */
  --bg-elev:     #111827;          /* elevated panels */
  --ink:         #e6eaf2;          /* high-contrast text */
  --muted:       #a6b0c2;
  --line:        rgba(255,255,255,.08);

  /* brand gradient */
  --accent:      #7c5cff;          /* grape */
  --accent-2:    #26d3ff;          /* aqua */
  --accent-ink:  #0b0f17;
  --accent-grad: linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%);

  /* glass */
  --glass-bg:    rgba(255,255,255,.06);
  --glass-brd:   rgba(255,255,255,.12);
  --blur-strength: 14px;

  /* radii */
  --r-sm: 10px; --r-md: 16px; --r-lg: 22px; --r-pill: 999px;

  /* shadows (elevations) */
  --elev-1: 0 6px 20px rgba(0,0,0,.22);
  --elev-2: 0 14px 40px rgba(0,0,0,.26);
  --elev-3: 0 24px 70px rgba(0,0,0,.34);

  /* motion */
  --ease-snap: cubic-bezier(.2, .8, .2, 1);          /* crisp UI */
  --ease-spring: cubic-bezier(.16, 1, .3, 1);        /* bouncy */
  --ease-soft: cubic-bezier(.22,.55,.25,1);          /* gentle */
  --dur-fast: 140ms; --dur-med: 220ms; --dur-slow: 380ms;
}

/* dark canvas */
html, body, #root { background: radial-gradient(1200px 800px at 70% -20%, #162033 0%, #0b0f17 60%) fixed; color: var(--ink); }
/* Glass card */
.card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-brd);
  -webkit-backdrop-filter: blur(var(--blur-strength)) saturate(160%);
  backdrop-filter: blur(var(--blur-strength)) saturate(160%);
  border-radius: var(--r-lg);
  box-shadow: var(--elev-2);
}

/* Primary action (gradient, lively) */
.btn-primary{
  position:relative; display:inline-flex; align-items:center; gap:10px;
  padding:12px 16px; border-radius: var(--r-pill);
  color:#0b0f17; background: var(--accent-grad);
  border: 1px solid transparent; font-weight:700;
  transform: translateZ(0);
  transition: transform var(--dur-fast) var(--ease-spring),
              box-shadow var(--dur-med) var(--ease-soft), filter var(--dur-fast) var(--ease-snap);
  box-shadow: 0 10px 24px rgba(124,92,255,.35);
}
.btn-primary:hover{ transform: translateY(-2px) scale(1.02); box-shadow: 0 16px 36px rgba(124,92,255,.45); }
.btn-primary:active{ transform: translateY(0) scale(.98); filter: saturate(.95); }

/* Secondary pill */
.btn{
  display:inline-flex; align-items:center; gap:8px; padding:10px 14px;
  border-radius: var(--r-pill); background: var(--bg-elev); color: var(--ink);
  border:1px solid var(--line);
  transition: transform var(--dur-fast) var(--ease-snap), background var(--dur-fast) var(--ease-snap);
}
.btn:hover{ transform: translateY(-1px); background: #151d2e; }

/* Tool dock (desktop & mobile) */
.tool-dock{
  background: var(--glass-bg);
  border: 1px solid var(--glass-brd);
  -webkit-
-filter: blur(var(--blur-strength)) saturate(160%);
  backdrop-filter: blur(var(--blur-strength)) saturate(160%);
  border-radius: 18px; box-shadow: var(--elev-2);
  animation: dockIn var(--dur-slow) var(--ease-spring) both;
}
@keyframes dockIn{ from{ opacity:0; transform: translate(-50%, 18px) scale(.98);} to{ opacity:1; transform: translate(-50%,0) scale(1);} }

/* Dock buttons upgrade */
.dock-btn{
  background: var(--bg-elev); color: var(--ink);
  border:1px solid var(--line); border-radius: var(--r-md);
  transition: transform var(--dur-fast) var(--ease-spring), box-shadow var(--dur-med) var(--ease-soft), background var(--dur-fast) var(--ease-soft);
}
.dock-btn:hover{ transform: translateY(-3px); box-shadow: var(--elev-1); background:#151d2e; }
.dock-btn:active{ transform: translateY(-1px) scale(.98); }

/* AR primary in dock */
.ar-primary{
  background: var(--accent-grad); color: var(--accent-ink); border-color: transparent;
  box-shadow: 0 12px 34px rgba(38,211,255,.32);
}
.ar-primary:hover{ box-shadow: 0 16px 44px rgba(38,211,255,.38); }
/* Pop + float */
@keyframes pop { 0%{transform:scale(.96)} 60%{transform:scale(1.04)} 100%{transform:scale(1)} }
@keyframes float { 0%,100%{ transform: translateY(0)} 50%{ transform: translateY(-2px)} }

/* Shimmer for progress/placeholder */
@keyframes shimmer { 0%{ background-position:-200% 0 } 100%{ background-position:200% 0 } }
.shimmer{
  background: linear-gradient(90deg, transparent, rgba(255,255,255,.06), transparent);
  background-size: 200% 100%;
  animation: shimmer 1.2s linear infinite;
}

/* Motion safety */
@media (prefers-reduced-motion: reduce){
  *{ animation: none !important; transition: none !important; }
}
.eyebrow{
  font-size:12px; letter-spacing:.18em; text-transform:uppercase;
  color:#bfa7ff; background: rgba(124,92,255,.12);
  border:1px solid rgba(124,92,255,.25); border-radius: var(--r-pill);
}
.title{ letter-spacing:-.01em; }
.sub{ color: var(--muted); }

/* stage dots */
.dot{ background: #111827; border: 1px solid var(--line); }
.dot.active{ background: var(--accent); border-color: transparent; box-shadow: 0 0 0 6px rgba(124,92,255,.18); transition: box-shadow var(--dur-med) var(--ease-soft); }

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

      --blur-strength: 10px;
      --glass-bg: rgba(255,255,255,0.55);
      --glass-border: rgba(255,255,255,0.6);
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
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
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

    /* ===== Mobile Radial Arc Menu ===== */
  /* Container shows only the top half of a 360x360 SVG */
  .radial-dock {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: max(calc(env(safe-area-inset-bottom) + 72px), 72px);
    z-index: 10;

    width: 360px;   /* full circle width */
    height: 180px;  /* show only top half */
    pointer-events: auto;
  }

  /* Wheel now uses a 360x360 viewBox and rotates around the true center-bottom edge */
  .radial-wheel {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 200%;            /* make sure the full 360 fits inside (since container is half-height) */
    transform-origin: 50% 50%;
    transition: transform 220ms cubic-bezier(.22,.9,.22,1);
    touch-action: none;
  }

  /* Slice animation polish */
  .slice-group {
    transform-box: fill-box;
    transform-origin: center;
    transition: transform 160ms ease, filter 160ms ease, opacity 200ms ease;
    opacity: .96;
  }
  .slice-group.active {
    transform: translateY(-4px) scale(1.04);
    filter: drop-shadow(0 6px 16px rgba(0,0,0,.12));
    opacity: 1;
  }

  .radial-slice {
    fill: #fff;
    stroke: var(--line);
    stroke-width: 1;
    transition: fill .15s ease, opacity .15s ease;
  }
  .radial-slice.active { fill: var(--accent); }

  .radial-label {
    font-size: 12px;
    text-anchor: middle;
    dominant-baseline: central;
    pointer-events: none;
  }

  /* Left/Right tap zones (invisible) */
  .radial-tap {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 44%;
    background: transparent;
    border: 0;
  }
  .radial-tap.left  { left: 0; }
  .radial-tap.right { right: 0; }

  /* Center AR button stays below the arc */
  .radial-center {
    position: absolute;
    left: 50%;
    bottom: -42px;
    transform: translateX(-50%);
    pointer-events: auto;
  }
  .radial-center .ar-btn {
    appearance: none;
    border: 1px solid var(--line);
    background: var(--accent);
    color: var(--accent-ink);
    width: 74px;
    height: 74px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-weight: 700;
    box-shadow: 0 12px 34px rgba(0,0,0,0.16);
    transition: transform .1s ease;
  }
  .radial-center .ar-btn:active { transform: scale(.97); }
  .radial-center .ar-btn svg { width: 20px; height: 20px; stroke: #fff; }


    /* ===== Loading Scrim (blur + bar) ===== */
    .loading-scrim {
      position: fixed;
      inset: 0;
      z-index: 7;
      display: grid;
      place-items: center;
      background: rgba(255,255,255,0.35);
      -webkit-backdrop-filter: blur(var(--blur-strength)) saturate(160%);
      backdrop-filter: blur(var(--blur-strength)) saturate(160%);
      transition: opacity .24s ease;
    }
    .loading-card {
      pointer-events: none;
      min-width: min(82vw, 440px);
      border-radius: 16px;
      padding: 18px 18px 14px;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      box-shadow: 0 24px 70px rgba(0,0,0,0.18);
    }
    .loading-title {
      font-size: 14px;
      margin-bottom: 10px;
      color: var(--ink);
    }
    .progress {
      position: relative;
      height: 8px;
      border-radius: 999px;
      background: #eef3f9;
      overflow: hidden;
      border: 1px solid #e2e8f0;
    }
    .progress-fill {
      position: absolute; top: 0; left: 0; height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #ff6a00 0%, #ffa04f 100%);
      transition: width .18s ease;
    }
    .progress[data-indeterminate="true"]::before {
      content: "";
      position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.06) 50%, transparent 100%);
      transform: translateX(-100%);
      animation: indet 1.1s linear infinite;
    }
      .viewer::after{
  content:"";
  position:absolute; inset:auto 0 16% 0; margin:auto;
  width:min(60vw,540px); height:200px; border-radius: 50%;
  background: radial-gradient(60% 60% at 50% 50%, rgba(124,92,255,.25), transparent 70%);
  filter: blur(28px);
  pointer-events:none; z-index:1;
}

    @keyframes indet {
      to { transform: translateX(100%); }
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

            {/* Headline */}
            <div className="hud">
              <div className="eyebrow">Premium Mattress Experience</div>
              <div key={headlineKey} className="headline-anim">
                <h1 className="title">{titleText}</h1>
                <p className="sub">
                  {subText}
                  {' '}• Pinch to zoom • Drag to orbit • Use wheel / swipe to move through stages.
                </p>
              </div>
            </div>

            {/* Right stage rail (desktop only) */}
            {!isMobile && (
              <div className="stage-rail">
                <button className="nav-chip" onClick={prevStage} aria-label="Previous">◀</button>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                  {Array.from({ length: totalStages }).map((_, i) => (
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
            )}

            {/* Desktop dock (intact) */}
            {!isMobile && (
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
  </div>
)}
{/* Dock (now shows on desktop + mobile) */}
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

  <button
    className="dock-btn ar-primary"
    onClick={onClickViewInAR}
    aria-label="View in your room"
  >
    <ArIcon /><span className="dock-label">View in AR</span>
  </button>
</div>

          </div>
        </div>

        {/* Loading Scrim (boots + model loads) */}
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

        {/* Hidden iOS Quick Look fallback target (must always exist in DOM) */}
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

  function RadialDock({
    parts,
    currentStage,
    onSelectStage,
    onAR,
    quickLookRef,
    usdzHref,
  }: {
    parts: NamedPart[]
    currentStage: number
    onSelectStage: (s: number) => void
    onAR: () => void
    quickLookRef: React.RefObject<HTMLAnchorElement>
    usdzHref: string
  }) {
    // Build menu: Overview, Exploded, then all sections
    const menuItems = useMemo(() => {
      const items = [
        { label: 'Overview', stage: 0 },
        { label: 'Exploded', stage: 1 },
      ]
      parts.forEach((p, idx) => items.push({ label: p.name || `Section ${idx + 1}`, stage: 2 + idx }))
      return items
    }, [parts])

    const N = Math.max(menuItems.length, 1)
    const SLICE_DEG = 360 / N            // equal slices around full circle
    const sliceAngle = SLICE_DEG

    // Rotation model
    const [rotation, setRotation] = useState(0)
    const targetRotation = useRef(0)

    const loop = (i: number, n: number) => (i % n + n) % n
    const activeIdx = loop(menuItems.findIndex(m => m.stage === currentStage), N)

    // Snap the wheel so the active slice center is at 12 o’clock (0° is up in our geometry)
    useEffect(() => {
      // center angle of the active slice (0° at 12 o’clock)
      const a0 = activeIdx * sliceAngle
      const ac = a0 + sliceAngle / 2
      targetRotation.current = -ac
      setRotation(targetRotation.current) // CSS transition makes this snappy
    }, [activeIdx, sliceAngle])

    // Drag to rotate (continuous) + snap on release
    const dragging = useRef(false)
    const dragStart = useRef<{ x: number; y: number } | null>(null)
    const dragAccumPx = useRef(0)
    const PX_PER_SLICE = 72 // ~how many pixels to move one slice

    const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
      (e.currentTarget as any).setPointerCapture?.(e.pointerId)
      dragging.current = true
      dragStart.current = { x: e.clientX, y: e.clientY }
      dragAccumPx.current = 0
    }
    const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
      if (!dragging.current || !dragStart.current) return
      const dx = e.clientX - dragStart.current.x
      dragStart.current.x = e.clientX
      dragAccumPx.current += dx

      // live rotate under finger (rightward drag = rotate positive)
      const dragDeg = (dragAccumPx.current / PX_PER_SLICE) * sliceAngle
      setRotation(targetRotation.current + dragDeg)
    }
    const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
      dragging.current = false
      ;(e.currentTarget as any).releasePointerCapture?.(e.pointerId)
      const steps = Math.round(dragAccumPx.current / PX_PER_SLICE)
      dragAccumPx.current = 0
      dragStart.current = null

      if (steps !== 0) {
        const nextIdx = loop(activeIdx - steps, N) // drag right -> previous
        onSelectStage(menuItems[nextIdx].stage)
      } else {
        setRotation(targetRotation.current) // snap back
      }
    }

    // Build full 360° slices (we’ll clip to top half)
    const R_OUT = 130
    const R_IN  = 72
    const CX = 180
    const CY = 180 // center of the full circle (note: different from before)

    const slices = useMemo(() => {
      return menuItems.map((m, i) => {
        const a0 = i * sliceAngle
        const a1 = a0 + sliceAngle
        const ac = (a0 + a1) / 2
        return {
          key: `${m.stage}`,
          d: donutSlicePath(CX, CY, R_IN, R_OUT, a0, a1),
          label: m.label,
          stage: m.stage,
          ac,
          labelPos: polar(CX, CY, (R_IN + R_OUT) / 2, ac),
          isActive: i === activeIdx,
        }
      })
    }, [menuItems, sliceAngle, activeIdx])

    // Left/right step zones (tap to step)
    const stepPrev = () => onSelectStage(menuItems[loop(activeIdx - 1, N)].stage)
    const stepNext = () => onSelectStage(menuItems[loop(activeIdx + 1, N)].stage)

    return (
      <div className="radial-dock">
        {/* iOS Quick Look anchor (kept in DOM) */}
        <a
          ref={quickLookRef}
          rel="ar"
          href={usdzHref || '/assets/bed.usdz'}
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
          aria-hidden="true"
        >
          <img src="/assets/poster.jpg" alt="" width={1} height={1} />
        </a>

        {/* Full wheel (360x360) clipped to show only the top half */}
        <svg
    viewBox="0 0 360 360"
    className="radial-wheel"
    style={{ transform: `rotate(${rotation}deg)` }}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerUp}
  >
    <defs>
      {/* reveal only top half (y <= 180) */}
      <clipPath id="clip-top-half" clipPathUnits="userSpaceOnUse">
        <rect x="0" y="0" width="360" height="180" />
      </clipPath>
    </defs>

    <g clipPath="url(#clip-top-half)">
      {slices.map((s) => (
        <g key={s.key} className={`slice-group ${s.isActive ? 'active' : ''}`} style={{ cursor: 'pointer' }}>
          <path className={`radial-slice ${s.isActive ? 'active' : ''}`} d={s.d} />
          <text
            x={s.labelPos.x}
            y={s.labelPos.y}
            className="radial-label"
            transform={`rotate(${-rotation - s.ac}, ${s.labelPos.x}, ${s.labelPos.y})`}
          >
            {shorten(s.label, 16)}
          </text>
        </g>
      ))}
    </g>
  </svg>

        {/* Invisible tap zones for quick step left/right */}
        <button className="radial-tap left" onClick={stepPrev} aria-label="Previous" />
        <button className="radial-tap right" onClick={stepNext} aria-label="Next" />

        {/* Center AR button (stays put; not clipped) */}
        <div className="radial-center">
          <button className="ar-btn" onClick={onAR} aria-label="View in AR">
            <ArIcon /><span>AR</span>
          </button>
        </div>
      </div>
    )
  }

  /* —— helpers —— */
  function polar(cx: number, cy: number, r: number, deg: number) {
    const a = ((deg - 90) * Math.PI) / 180
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  }
  function donutSlicePath(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number) {
    const toRad = (d: number) => ((d - 90) * Math.PI) / 180
    const a0r = toRad(a0), a1r = toRad(a1)
    const x0o = cx + rOut * Math.cos(a0r), y0o = cy + rOut * Math.sin(a0r)
    const x1o = cx + rOut * Math.cos(a1r), y1o = cy + rOut * Math.sin(a1r)
    const x0i = cx + rIn  * Math.cos(a1r), y0i = cy + rIn  * Math.sin(a1r)
    const x1i = cx + rIn  * Math.cos(a0r), y1i = cy + rIn  * Math.sin(a0r)
    return `M${x0o},${y0o} A${rOut},${rOut} 0 0 1 ${x1o},${y1o} L${x0i},${y0i} A${rIn},${rIn} 0 0 0 ${x1i},${y1i}Z`
  }
  function shorten(s: string, n = 14) {
    return s.length > n ? s.slice(0, n - 1) + '…' : s
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
