"use client";

import { useEffect, useRef } from "react";

/** 1× realtime both directions — clock-driven so forward ≠ reverse scrub mismatch. */
const PLAYBACK_RATE = 1;

/**
 * Inset cosmos loop (forward ↔ reverse). Visible only while `active`
 * — fades in on enter, fades out on leave; no motion outside the flow.
 */
export function CosmosBackdrop({ active }: { active: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let raf = 0;
    let dir: 1 | -1 = 1;
    let playhead = 0;
    let lastTs = 0;
    let seeking = false;
    let queued: number | null = null;
    let running = false;

    const duration = () => {
      const d = video.duration;
      return Number.isFinite(d) && d > 0 ? d : 0;
    };

    const onSeeked = () => {
      seeking = false;
      if (queued == null) return;
      const t = queued;
      queued = null;
      seekTo(t);
    };

    const seekTo = (t: number) => {
      const dur = duration();
      if (dur <= 0) return;
      const clamped = Math.min(dur, Math.max(0, t));
      if (seeking) {
        queued = clamped;
        return;
      }
      // Skip no-op seeks — cuts decoder thrash at turnarounds
      if (Math.abs(video.currentTime - clamped) < 1 / 120) return;
      seeking = true;
      try {
        if (typeof video.fastSeek === "function") video.fastSeek(clamped);
        else video.currentTime = clamped;
      } catch {
        video.currentTime = clamped;
      }
    };

    const reflect = (t: number, dur: number): number => {
      // Mirror over endpoints so turnarounds stay continuous at the same speed
      let x = t;
      let d = dir;
      for (let i = 0; i < 4; i++) {
        if (x > dur) {
          x = dur - (x - dur);
          d = -1;
        } else if (x < 0) {
          x = -x;
          d = 1;
        } else break;
      }
      dir = d;
      return Math.min(dur, Math.max(0, x));
    };

    const tick = (now: number) => {
      if (!running || !activeRef.current) return;
      if (!lastTs) lastTs = now;
      const dt = Math.min(0.05, (now - lastTs) / 1000);
      lastTs = now;

      const dur = duration();
      if (dur > 0) {
        playhead = reflect(playhead + dir * PLAYBACK_RATE * dt, dur);
        seekTo(playhead);
      }

      raf = requestAnimationFrame(tick);
    };

    const stop = () => {
      running = false;
      lastTs = 0;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      video.pause();
      queued = null;
      seeking = false;
    };

    const start = () => {
      if (!activeRef.current) return;
      video.muted = true;
      video.playsInline = true;
      video.loop = false;
      video.pause();
      dir = 1;
      playhead = 0;
      lastTs = 0;
      queued = null;
      seeking = false;
      video.currentTime = 0;
      running = true;
      raf = requestAnimationFrame(tick);
    };

    video.addEventListener("seeked", onSeeked);

    if (!active) {
      stop();
      video.removeEventListener("seeked", onSeeked);
      return;
    }

    const onReady = () => {
      video.removeEventListener("loadeddata", onReady);
      start();
    };

    if (video.readyState >= 2) start();
    else {
      video.addEventListener("loadeddata", onReady);
      void video.load();
    }

    const onVis = () => {
      if (document.hidden) {
        stop();
      } else if (activeRef.current) {
        // Resume from last playhead so direction stays consistent
        running = true;
        lastTs = 0;
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      stop();
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadeddata", onReady);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [active]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-[var(--paper)]"
    >
      <video
        ref={videoRef}
        className={`absolute top-1/2 left-1/2 h-[calc(100%-5rem)] w-[calc(100%-4rem)] max-w-[72rem] -translate-x-1/2 -translate-y-1/2 rounded-2xl object-cover object-center transition-opacity duration-700 ease-out md:h-[calc(100%-6.5rem)] md:w-[calc(100%-6rem)] ${
          active ? "opacity-100" : "opacity-0"
        }`}
        src="/cosmos_compressed.mp4"
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
      />
      <div
        className={`absolute top-1/2 left-1/2 h-[calc(100%-5rem)] w-[calc(100%-4rem)] max-w-[72rem] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-[radial-gradient(ellipse_at_center,rgba(12,17,16,0.22)_0%,rgba(12,17,16,0.55)_60%,rgba(8,12,11,0.78)_100%)] transition-opacity duration-700 ease-out md:h-[calc(100%-6.5rem)] md:w-[calc(100%-6rem)] ${
          active ? "opacity-100" : "opacity-0"
        }`}
      />
    </div>
  );
}
