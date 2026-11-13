import React, {useEffect, useState} from 'react';
import {
  continueRender,
  delayRender,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';

// Arena palette (cream/paper + ink + orange + teal), matched to web/style.css
export const C = {
  paper: '#F5EEDF',
  paperDeep: '#EDE2C8',
  ink: '#211A10',
  inkSoft: '#4A3F2C',
  card: '#FFFDF6',
  line: '#2A2118',
  orange: '#E4571D',
  orangeSoft: '#F6CDB4',
  teal: '#0E7C74',
  tealDark: '#0A5C56',
  green: '#1E8A49',
  greenBg: '#DFF2E2',
  red: '#C0392B',
  sand: '#D8C9A8',
};

let fontHandle: number | null = null;

export const usePoppins = () => {
  const [, setReady] = useState(false);
  useEffect(() => {
    if (fontHandle === null) fontHandle = delayRender('poppins-fonts');
    const faces = [
      new FontFace('Poppins', `url(${staticFile('fonts/poppins-600.ttf')})`, {weight: '600'}),
      new FontFace('Poppins', `url(${staticFile('fonts/poppins-800.ttf')})`, {weight: '800'}),
      new FontFace('Poppins', `url(${staticFile('fonts/poppins-900.ttf')})`, {weight: '900'}),
    ];
    Promise.all(
      faces.map((f) => {
        document.fonts.add(f);
        return f.load();
      }),
    )
      .then(() => {
        setReady(true);
        if (fontHandle !== null) {
          continueRender(fontHandle);
          fontHandle = null;
        }
      })
      .catch(() => {
        if (fontHandle !== null) {
          continueRender(fontHandle);
          fontHandle = null;
        }
      });
  }, []);
};

export const fadeUp = (frame: number, start: number, dur = 14) => {
  const t = interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return {opacity: t, transform: `translateY(${Math.round((1 - t) * 26)}px)`};
};

export const Kicker: React.FC<{children: React.ReactNode; frame: number; start?: number}> = ({
  children,
  frame,
  start = 2,
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      ...fadeUp(frame, start, 12),
    }}
  >
    <div style={{width: 18, height: 18, background: C.orange, borderRadius: 5}} />
    <div
      style={{
        fontFamily: 'Poppins',
        fontWeight: 800,
        fontSize: 27,
        letterSpacing: 5,
        color: C.ink,
      }}
    >
      {children}
    </div>
  </div>
);

export const BrowserCard: React.FC<{
  url: string;
  height: number;
  children: React.ReactNode;
  frame: number;
  start?: number;
}> = ({url, height, children, frame, start = 4}) => (
  <div
    style={{
      width: 1620,
      borderRadius: 26,
      background: C.card,
      border: `3px solid ${C.line}`,
      boxShadow: '0 30px 60px rgba(33,26,16,0.20)',
      overflow: 'hidden',
      ...fadeUp(frame, start, 16),
    }}
  >
    <div
      style={{
        height: 54,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 22px',
        borderBottom: `2px solid ${C.sand}`,
        background: '#FBF6EA',
      }}
    >
      <div style={{width: 15, height: 15, borderRadius: 8, background: '#E0654A'}} />
      <div style={{width: 15, height: 15, borderRadius: 8, background: '#E8A33D'}} />
      <div style={{width: 15, height: 15, borderRadius: 8, background: '#3FA46A'}} />
      <div
        style={{
          marginLeft: 16,
          fontFamily: 'Poppins',
          fontWeight: 600,
          fontSize: 20,
          color: C.inkSoft,
          background: '#F1E8D2',
          borderRadius: 999,
          padding: '5px 18px',
        }}
      >
        {url}
      </div>
    </div>
    <div style={{height, overflow: 'hidden', position: 'relative'}}>{children}</div>
  </div>
);

// A still with a gentle Ken Burns pan/zoom inside its card viewport.
// The img keeps its natural aspect (height auto) so translateY pans across
// the real image instead of sliding a cover-cropped box.
export const StillView: React.FC<{
  src: string;
  dur: number;
  scaleFrom?: number;
  scaleTo?: number;
  tyFrom?: number;
  tyTo?: number;
}> = ({src, dur, scaleFrom = 1.02, scaleTo = 1.08, tyFrom = 0, tyTo = -60}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, dur], [scaleFrom, scaleTo], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const ty = interpolate(frame, [0, dur], [tyFrom, tyTo], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <Img
      src={staticFile(src)}
      style={{
        width: '100%',
        height: 'auto',
        display: 'block',
        transformOrigin: 'top center',
        transform: `scale(${scale}) translateY(${ty}px)`,
      }}
    />
  );
};

export const Caption: React.FC<{
  frame: number;
  start: number;
  lines: React.ReactNode[];
  size?: number;
}> = ({frame, start, lines, size = 64}) => (
  <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
    {lines.map((ln, i) => (
      <div
        key={i}
        style={{
          fontFamily: 'Poppins',
          fontWeight: 800,
          fontSize: size,
          lineHeight: 1.12,
          color: C.ink,
          ...fadeUp(frame, start + i * 16, 14),
        }}
      >
        {ln}
      </div>
    ))}
  </div>
);

export const Chip: React.FC<{children: React.ReactNode; bg?: string; color?: string}> = ({
  children,
  bg = C.card,
  color = C.ink,
}) => (
  <div
    style={{
      fontFamily: 'Poppins',
      fontWeight: 600,
      fontSize: 24,
      color,
      background: bg,
      border: `2px solid ${C.line}`,
      borderRadius: 999,
      padding: '9px 22px',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </div>
);

export const SceneShell: React.FC<{
  kicker: string;
  frame: number;
  children: React.ReactNode;
}> = ({kicker, frame, children}) => (
  <div
    style={{
      width: '100%',
      height: '100%',
      background: `linear-gradient(160deg, ${C.paper} 0%, ${C.paperDeep} 100%)`,
      padding: '64px 150px 56px',
      display: 'flex',
      flexDirection: 'column',
      gap: 30,
      fontFamily: 'Poppins',
    }}
  >
    <Kicker frame={frame}>{kicker}</Kicker>
    {children}
  </div>
);
