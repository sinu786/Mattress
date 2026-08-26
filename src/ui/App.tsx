// src/ui/App.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ViewerHandle, InitOptions } from '../viewer'
import './app.css'

type NamedPart = { name: string; index: number; num: number }
// ScrollController.ts (or inside your App.tsx)
// Custom zoom factors (padding multipliers) for each layer.
// Lower number = closer zoom. Higher number = farther away.
const LAYER_ZOOMS: Record<number, number> = {
  1: 0.5, // Cashmere tufting: Very close macro shot
  2: 0.75,  // Memory core: Medium distance
  3: 0.75,  // Thermal matrix: Medium distance
  4: 1.2,  // Coils: Farther away to see the full grid array
  5: 0.4,  // Base Foundation: Slightly pulled back to see the thick block
}


export function createDiscreteScroll(
  onScrollUp: () => void, 
  onScrollDown: () => void, 
  cooldownMs = 1200 // Time to lock out other events (adjust to match your camera lerp time)
) {
  let isLocked = false;

  return function handleWheel(e: WheelEvent) {
    // Ignore tiny micro-scrolls to prevent accidental triggers
    if (Math.abs(e.deltaY) < 15) return; 

    if (isLocked) return;

    if (e.deltaY > 0) {
      onScrollDown();
    } else {
      onScrollUp();
    }

    // Lock the scroll until the camera finishes moving
    isLocked = true;
    setTimeout(() => {
      isLocked = false;
    }, cooldownMs);
  };
}


export default function App() {
  const mountRef = useRef<HTMLDivElement>(null)
  const [handle, setHandle] = useState<ViewerHandle | null>(null)

  // UI state
  const [status, setStatus] = useState('Drop a .glb or pick a file to load…')
  const [exposure, setExposure] = useState(1.1)
  const [autoRotate, setAutoRotate] = useState(true)
  const [usdzHref, setUsdzHref] = useState('')
  
  // Portrait Lock bypass state
  const [skipPortraitLock, setSkipPortraitLock] = useState(false)

  // Loading/boot states
  const [booting, setBooting] = useState(true)
  const [modelLoading, setModelLoading] = useState(false)
  const [loadPct, setLoadPct] = useState<number | null>(null)
  const progTimer = useRef<number | null>(null)

  // Named sections
  const [namedParts, setNamedParts] = useState<NamedPart[]>([])
  const [stage, setStage] = useState(0)

  // Audio state
  const audioRef = useRef<HTMLAudioElement>(null)
  const switchAudioRef = useRef<HTMLAudioElement>(null)
  const explodeAudioRef = useRef<HTMLAudioElement>(null)
  
  const [isMuted, setIsMuted] = useState(false)
  const [audioUnlocked, setAudioUnlocked] = useState(false)
  const prevStageRef = useRef<number>(0)

  // Headline animation key
  const [headlineKey, setHeadlineKey] = useState(0)

  const handleDiscreteWheel = useMemo(() => {
    return createDiscreteScroll(() => prevStage(), () => nextStage(), 600)
  }, [])

  const quickLookRef = useRef<HTMLAnchorElement>(null)

  // Audio Autoplay Unlocker
  useEffect(() => {
    const unlockAudio = () => {
      if (!audioUnlocked) {
        if (audioRef.current) {
          audioRef.current.volume = 0.3
          audioRef.current.play().catch(() => {})
        }
        const unlockSfx = (el: HTMLAudioElement | null) => {
          if (!el) return
          el.volume = 0.0
          el.play().then(() => { el.pause(); el.currentTime = 0; el.volume = 0.6 }).catch(() => {})
        }
        unlockSfx(switchAudioRef.current)
        unlockSfx(explodeAudioRef.current)
        setAudioUnlocked(true)
      }
      window.removeEventListener('pointerdown', unlockAudio)
      window.removeEventListener('touchstart', unlockAudio)
    }
    window.addEventListener('pointerdown', unlockAudio)
    window.addEventListener('touchstart', unlockAudio)
    return () => {
      window.removeEventListener('pointerdown', unlockAudio)
      window.removeEventListener('touchstart', unlockAudio)
    }
  }, [audioUnlocked])

  // ---------- init viewer
  useEffect(() => {
    if (!mountRef.current) return
    let cleanup = () => {}

    ;(async () => {
      // We can still detect mobile to pass variables if needed, 
      // but we import the exact same viewer file for both.
      const isMobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (window.innerWidth < 820)
      
      // FIX: Always import from '../viewer'
      const viewerModule = await import('../viewer')
      
      const initViewer = viewerModule.initViewer as (el: HTMLElement, opts?: InitOptions) => Promise<ViewerHandle>
      const disposeViewer = viewerModule.disposeViewer as (h: ViewerHandle) => void

      setBooting(true)
      const h = await initViewer(mountRef.current!, {
        showHDRIBackground: false,
        enableShadows: true,
        toneMappingExposure: exposure,
        bloomEnabled: true,
        scrollScrub: false,
        backdropColor: 0xEDE8DE,
        toneInit: {
          curve: 'ACES', exposure: 1.1, lift: [-0.015, -0.015, -0.015],
          gamma: [1.02, 1.00, 0.98], gain: [1.03, 1.02, 1.05],
          warmth: 0.8, saturation: 1.0, vibrance: -0.05, contrast: 1.01,
        }
      })
      
      setHandle(h)
      const names = h.getPartNames?.() ?? []
      setNamedParts(parseNamedParts(names))
      h.setExplode(0)
      h.isolateIndex(null)
      h.setOrbitTargetTo(null)
      requestAnimationFrame(() => { setTimeout(() => setBooting(false), 120) })
      cleanup = () => disposeViewer(h)
    })()
    return () => cleanup()
  }, [])


  // Reactive controls & SFX
  useEffect(() => { handle?.setExposure(exposure) }, [exposure, handle])
  useEffect(() => { handle?.setAutoRotate(autoRotate) }, [autoRotate, handle])
  useEffect(() => {
    if (stage === prevStageRef.current) return
    const playSfx = (el: HTMLAudioElement | null) => {
      if (el && !isMuted && audioUnlocked) { el.currentTime = 0; el.play().catch(() => {}) }
    }
    if (stage === 1 || (prevStageRef.current === 1 && stage === 0)) playSfx(explodeAudioRef.current)
    else playSfx(switchAudioRef.current)
    prevStageRef.current = stage
  }, [stage, isMuted, audioUnlocked])

  // Apply stage
  useEffect(() => {
    if (!handle) return
    applyStage(handle, stage, namedParts)
    setHeadlineKey(k => k + 1)
  }, [handle, stage, namedParts])

  // --- SMART INTERACTION: ORBIT & ZOOM WITH SNAP-BACK ---
  const [showGuide, setShowGuide] = useState(true)
  const autoResetTimer = useRef<number | null>(null)

  useEffect(() => {
    const host = mountRef.current
    if (!host || !handle) return

    let pinchStartDist = 0
    let pinchActive = false

    const dist = (t1: Touch, t2: Touch) => Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY)

    const clearTimer = () => {
      setShowGuide(false)
      if (autoResetTimer.current) window.clearTimeout(autoResetTimer.current)
    }

    const startTimer = () => {
      if (autoResetTimer.current) window.clearTimeout(autoResetTimer.current)
      autoResetTimer.current = window.setTimeout(() => {
        applyStage(handle, stage, namedParts, true) // trigger slow float back
      }, 2500)
    }

    const onTouchStart = (e: TouchEvent) => {
      clearTimer()
      if (e.touches.length === 2) {
        pinchActive = true
        pinchStartDist = dist(e.touches[0], e.touches[1])
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (pinchActive && e.touches.length === 2) {
        e.preventDefault()
        const d = dist(e.touches[0], e.touches[1])
        if (pinchStartDist > 0) handle.dolly?.(d / pinchStartDist > 1 ? 0.95 : 1.05)
        pinchStartDist = d
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (pinchActive && e.touches.length < 2) {
        pinchActive = false
        pinchStartDist = 0
      }
      startTimer()
    }

    const onWheel = (e: WheelEvent) => {
      clearTimer()
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        handle.dolly?.(Math.exp((e.deltaY / 100) * 0.15))
        startTimer()
      } else {
        handleDiscreteWheel(e)
      }
    }

    // Attach both touch and pointer mouse listeners
    host.addEventListener('touchstart', onTouchStart, { passive: true })
    host.addEventListener('touchmove', onTouchMove, { passive: false })
    host.addEventListener('touchend', onTouchEnd, { passive: true })
    host.addEventListener('touchcancel', onTouchEnd, { passive: true })

    host.addEventListener('pointerdown', clearTimer)
    host.addEventListener('pointerup', startTimer)
    host.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      if (autoResetTimer.current) window.clearTimeout(autoResetTimer.current)
      host.removeEventListener('touchstart', onTouchStart as any)
      host.removeEventListener('touchmove', onTouchMove as any)
      host.removeEventListener('touchend', onTouchEnd as any)
      host.removeEventListener('touchcancel', onTouchEnd as any)
      host.removeEventListener('pointerdown', clearTimer as any)
      host.removeEventListener('pointerup', startTimer as any)
      host.removeEventListener('wheel', onWheel as any)
    }
  }, [handle, handleDiscreteWheel, stage, namedParts])


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

  // 1. Create a ref to hold the fresh stage count
  const totalStagesRef = useRef(2)
  useEffect(() => {
    totalStagesRef.current = 2 + namedParts.length
  }, [namedParts])

  // 2. Use functional state updates + the ref so stale closures don't break the math
  const nextStage = () => setStage(s => {
    const total = totalStagesRef.current
    return total <= 0 ? 0 : (s + 1) % total
  })
  
  const prevStage = () => setStage(s => {
    const total = totalStagesRef.current
    return total <= 0 ? 0 : (s - 1 + total) % total
  })


  function applyStage(h: ViewerHandle, idx: number, parts: NamedPart[], snapBack = false) {
    if (idx === 0) {
      h.setExplode(0)
      h.isolateIndex(null)
      h.setOrbitTargetByName(null, undefined, snapBack)
      return
    }
    if (idx === 1) {
      h.setExplode(1)
      h.isolateIndex(null)
      h.setOrbitTargetByName(null, undefined, snapBack)
      return
    }
    const p = parts[idx - 2]
    if (p) {
      h.setExplode(1)
      h.isolateIndex(p.index, 0.22)
      const customZoom = LAYER_ZOOMS[p.num] ?? 1.1
      h.setOrbitTargetByName(p.name, customZoom, snapBack)
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
    setStatus('Loading model (Throttled network detected)…')
    setModelLoading(true)
    setLoadPct(0)
    
    try {
      // Pass the real progress callback into loadGLB
      await handle.loadGLB(f, (pct) => {
        setLoadPct(pct)
      })
      
      const names = handle.getPartNames?.() ?? []
      setNamedParts(parseNamedParts(names))
      setStage(0)
      handle.setExplode(0)
      handle?.isolateIndex(null)
      handle.setOrbitTargetTo(null)
      setStatus('Model loaded.')
    } catch (err: unknown) { 
      console.error(err); 
      setStatus('Failed to load model.') 
    } finally { 
      e.target.value = ''
      finishProgress() 
    }
  }

  function onDrop(ev: React.DragEvent<HTMLDivElement>) {
    ev.preventDefault()
    const file = ev.dataTransfer.files?.[0]; if (!file || !handle) return
    const name = file.name.toLowerCase()
    setStatus('Loading model…')

    if (name.endsWith('.glb') || name.endsWith('.gltf')) {
      setModelLoading(true)
      setLoadPct(0)

      handle.loadGLB(file, (pct) => {
        setLoadPct(pct)
      }).then(() => {
        const names = handle.getPartNames?.() ?? []
        setNamedParts(parseNamedParts(names))
        setStage(0)
        handle.setExplode(0)
        handle.isolateIndex(null)
        handle.setOrbitTargetTo(null)
        setStatus('Model loaded.')
      }).catch((err: unknown) => { 
        console.error(err); 
        setStatus('Failed to load model.') 
      }).finally(() => finishProgress())
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

  const totalLayers = 2 + namedParts.length // Needed for the dots

  return (
    // Add portrait-mode class conditionally
    <div className={`app-root ${skipPortraitLock ? 'portrait-mode' : ''}`}>

      {/* Interactive Guides (Fades out on touch/scroll) */}
      <div className={`interaction-guide ${showGuide ? '' : 'hidden'}`}>
        <div className="guide-desktop">
          <MouseIcon />
          <p>Scroll to explore layers<br/>Click & drag to orbit</p>
        </div>
        <div className="guide-mobile">
          <div className="guide-row"><UpArrowIcon /> <p>Tap arrows to explore layers</p></div>
          <div className="guide-row"><HoldIcon /> <p>Hold to orbit & pinch to zoom</p></div>
        </div>
      </div>

      {/* Portrait Lock Overlay */}
      {!skipPortraitLock && (
        <div className="portrait-lock">
          <div className="portrait-lock-content">
            <RotateIcon />
            <p>Please rotate your device<br/>for the optimal experience.</p>
            <button className="skip-lock-btn" onClick={() => setSkipPortraitLock(true)}>
              Continue in Portrait
            </button>
          </div>
        </div>
      )}

      {/* Audio Elements */}
      <audio ref={audioRef} src="/assets/music.mp3" loop playsInline preload="none" />
      <audio ref={switchAudioRef} src="/assets/switch.mp3" playsInline preload="none" />
      <audio ref={explodeAudioRef} src="/assets/explode.mp3" playsInline preload="none" />
  
      {/* Viewer */}
      <div className="viewer" ref={mountRef} onDrop={onDrop} onDragOver={onDragOver}>
        <div className="canvas-overlay">
  
          {/* FIX: Centered Luxury Brand Title moved INSIDE the overlay! */}
          <div className="overlay-topbar">
            <div className="brand-logo">VULF</div>
          </div>

          {/* Presentation HUD */}
          <div className="hud">
            <div className="eyebrow">Luxury Presentation</div>

            <div key={`headline-${stage}-${headlineKey}`} className="headline-anim">
              <h1 className="title">{titleText}</h1>
              <p className="sub">{subText}</p>
            </div>
          </div>

          {/* NEW LAYER NAVIGATION (UP/DOWN ARROWS) */}
          <div className="layer-nav">
            <button className="layer-nav-btn" onClick={prevStage} disabled={stage === 0} aria-label="Previous Layer">
              <UpArrowIcon />
            </button>
            <div className="layer-nav-dots">
              {Array.from({ length: totalLayers }).map((_, i) => (
                <div key={i} className={`layer-dot ${i === stage ? 'active' : ''}`} />
              ))}
            </div>
            <button className="layer-nav-btn" onClick={nextStage} disabled={stage === totalLayers - 1} aria-label="Next Layer">
              <DownArrowIcon />
            </button>
          </div>

          {/* Floating Architectural Dock */}
          <div className="tool-dock">

            <button
              className="dock-btn"
              onClick={() => {
                if (!audioRef.current) return
                if (audioRef.current.paused || isMuted) {
                  audioRef.current.play()
                  setIsMuted(false)
                } else {
                  audioRef.current.pause()
                  setIsMuted(true)
                }
              }}
              aria-label="Toggle Sound"
            >
              <span className="dock-btn-icon">{isMuted ? <MutedIcon /> : <SoundIcon />}</span>
              <span className="dock-btn-text">
                <span className="dock-label-primary">Sound</span>
                <span className="dock-label-secondary">{isMuted ? 'Off' : 'On'}</span>
              </span>
            </button>

            <button className="dock-btn" onClick={() => setStage(0)} aria-label="Overview">
              <span className="dock-btn-icon"><OverviewIcon /></span>
              <span className="dock-btn-text">
                <span className="dock-label-primary">Overview</span>
                <span className="dock-label-secondary">Comfort</span>
              </span>
            </button>

            <button className="dock-btn" onClick={() => setStage(1)} aria-label="Layers & Materials">
              <span className="dock-btn-icon"><ExplodedIcon /></span>
              <span className="dock-btn-text">
                <span className="dock-label-primary">Layers &amp;</span>
                <span className="dock-label-secondary">Materials</span>
              </span>
            </button>

            <button
              className="dock-btn"
              onClick={() => {
                handle?.setExplode(0)
                handle?.isolateIndex?.(null)
                handle?.setOrbitTargetTo(null)
                setStage(0)
              }}
              aria-label="Re-Center View"
            >
              <span className="dock-btn-icon"><ResetIcon /></span>
              <span className="dock-btn-text">
                <span className="dock-label-primary">Re-Center</span>
                <span className="dock-label-secondary">View</span>
              </span>
            </button>

            <button className="dock-btn primary" onClick={onClickViewInAR} aria-label="View In Room">
              <span className="dock-btn-icon"><ArIcon /></span>
              <span className="dock-btn-text">
                <span className="dock-label-primary">View In Your</span>
                <span className="dock-label-secondary">Room (AR)</span>
              </span>
            </button>
          </div>



        </div>
      </div>
  
      {/* Loading Scrim */}
      {showLoading && (
        <div className="loading-scrim" aria-busy="true" aria-live="polite">
          <div className="loading-card">
            <div className="loading-title">
              {booting ? 'Initializing Experience' : (status || 'Loading Model')}
            </div>
            <div className="progress">
              <div
                className="progress-fill"
                style={{ width: loadPct && loadPct > 0 ? `${Math.min(100, loadPct)}%` : '100%' }}
              />
            </div>
          </div>
        </div>
      )}
  
      {/* iOS Quick Look Anchor */}
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
  
/* —— stage copy helpers —— */
function getStageCopy(stage: number, parts: NamedPart[]) {
  // Defaults
  let titleText = 'The Architecture of Sleep'
  let subText = 'Experience uncompromising comfort from every angle.'

  if (stage === 0) {
    titleText = 'Unveiling the Masterpiece'
    subText = 'Explore the precision engineering beneath the surface.'
  } else if (stage === 1) {
    titleText = 'A Symphony of Materials'
    subText = 'Discover how each artisan-crafted layer works in absolute harmony.'
  } else {
    const p = parts[stage - 2]
    const secNum = p?.num
    switch (secNum) {
      case 1:
        titleText = 'Cashmere-Blend Tufting'
        subText = 'A breathable, hand-stitched surface that instinctively responds to your touch.'
        break
      case 2:
        titleText = 'Visco-Elastic Memory Core'
        subText = 'Weightless contouring that provides flawless spinal alignment.'
        break
      case 3:
        titleText = 'Thermal-Regulating Matrix'
        subText = 'Advanced graphite channels effortlessly dissipate heat for undisturbed rest.'
        break
      case 4:
        titleText = 'Titanium Pocketed Coils'
        subText = 'Whisper-quiet motion isolation paired with dynamic, targeted lift.'
        break
      case 5:
        titleText = 'High-Density Base Foundation'
        subText = 'The structural anchor ensuring decades of unwavering support.'
        break
      default:
        titleText = p?.name ?? 'Bespoke Engineering'
        subText = 'Focusing on the finer details of your comfort.'
        break
    }
  }
  return { titleText, subText }
}

/* —— icons —— */
/* —— Elegant, Lightweight Line Icons —— */

function OverviewIcon() {
  // Isometric mattress / bed outline
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 13.5 12 9l9 4.5-9 4.5-9-4.5Z" />
      <path d="M3 13.5V17l9 4.5 9-4.5v-3.5" />
    </svg>
  )
}

function ExplodedIcon() {
  // Exploded / layered horizontal sheets
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 2.5 8.5 4.5-8.5 4.5-8.5-4.5Z" />
      <path d="m3.5 11.5 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16 8.5 4.5 8.5-4.5" />
    </svg>
  )
}

function ResetIcon() {
  // Clean circular loop
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <polyline points="3 3 3 8 8 8" />
    </svg>
  )
}

function ArIcon() {
  // Clean Corner bracket + AR tag
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8V5a1 1 0 0 1 1-1h3" />
      <path d="M16 4h3a1 1 0 0 1 1 1v3" />
      <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
      <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
      <text x="6.5" y="14.8" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none" fontFamily="sans-serif">AR</text>
    </svg>
  )
}

function SoundIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  )
}

function MutedIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="1" x2="1" y2="23" />
    </svg>
  )
}function RotateIcon() {
  return (
    <svg className="rotate-phone-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="2" width="14" height="20" rx="3" ry="3" />
      <path d="M12 18h.01" strokeWidth="2" />
    </svg>
  )
}function MouseIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="3" width="10" height="18" rx="5" />
      <path d="M12 7v4" />
    </svg>
  )
}
function SwipeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M16 9l-4-4-4 4M16 19l-4 4-4-4" />
    </svg>
  )
}
function HoldIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11V6a2 2 0 0 1 4 0v5" />
      <path d="M9 11v6a5 5 0 0 0 10 0V9a2 2 0 0 0-4 0v2" />
      <path d="M15 11v-1a2 2 0 0 0-4 0v1" />
      <circle cx="12" cy="12" r="10" strokeDasharray="4 4" />
    </svg>
  )
}
function UpArrowIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg> }
function DownArrowIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg> }

}