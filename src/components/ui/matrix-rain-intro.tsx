import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type MatrixRainIntroProps = {
  durationMs?: number;
};

export function MatrixRainIntro({ durationMs = 3200 }: MatrixRainIntroProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem("wwx.matrixIntroSeen") !== "1";
  });
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const glyphs = "01ARCMBLFS41WWX";
    let width = 0;
    let height = 0;
    let columns = 0;
    const fontSize = 15;
    let drops: number[] = [];
    let raf = 0;
    let last = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      columns = Math.ceil(width / fontSize);
      drops = Array.from({ length: columns }, () => Math.random() * -height);
    };

    const draw = (time: number) => {
      if (time - last > 42) {
        last = time;
        ctx.fillStyle = "rgba(18, 19, 22, 0.20)";
        ctx.fillRect(0, 0, width, height);
        ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.fillStyle = "rgba(74, 222, 128, 0.55)";
        for (let i = 0; i < drops.length; i += 1) {
          const char = glyphs[Math.floor(Math.random() * glyphs.length)];
          ctx.fillText(char, i * fontSize, drops[i]);
          drops[i] += fontSize;
          if (drops[i] > height + fontSize && Math.random() > 0.965) {
            drops[i] = Math.random() * -160;
          }
        }
      }
      raf = window.requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize);
    raf = window.requestAnimationFrame(draw);

    const leaveTimer = window.setTimeout(() => setLeaving(true), durationMs);
    const removeTimer = window.setTimeout(() => {
      window.sessionStorage.setItem("wwx.matrixIntroSeen", "1");
      setVisible(false);
    }, durationMs + 900);

    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(leaveTimer);
      window.clearTimeout(removeTimer);
      window.removeEventListener("resize", resize);
    };
  }, [durationMs, visible]);

  if (!visible) return null;

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-[100] overflow-hidden bg-[#121316] transition-opacity duration-700 ease-out",
        leaving ? "opacity-0" : "opacity-100",
      )}
    >
      <canvas ref={canvasRef} className="absolute inset-0 opacity-80" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(18,19,22,0.45)_58%,rgba(18,19,22,0.86)_100%)]" />
    </div>
  );
}
