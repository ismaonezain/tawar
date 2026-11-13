import React from 'react';
import {
  AbsoluteFill,
  Audio,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import {SEGMENTS} from './config';
import {BrowserCard, C, Caption, Chip, fadeUp, SceneShell, StillView, usePoppins} from './kit';

const HL: React.FC<{children: React.ReactNode}> = ({children}) => (
  <span style={{color: C.orange}}>{children}</span>
);
const TEAL: React.FC<{children: React.ReactNode}> = ({children}) => (
  <span style={{color: C.tealDark}}>{children}</span>
);

/* ---------------- Scene 1 · hook ---------------- */
const S1: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <SceneShell kicker="TAWAR · SERV HACKATHON 02 · KITE TRACK" frame={frame}>
      <BrowserCard url="tawar — the arena" height={560} frame={frame}>
        <StillView src="stills/s1-hero.png" dur={SEGMENTS[0].slot} scaleFrom={1.02} scaleTo={1.08} tyFrom={0} tyTo={-120} />
      </BrowserCard>
      <Caption
        frame={frame}
        start={10}
        lines={[
          <>This agent <HL>haggles</HL> for you.</>,
          <>It is not allowed to <HL>overspend</HL>.</>,
        ]}
      />
    </SceneShell>
  );
};

/* ---------------- Scene 2 · the mandate ---------------- */
const S2: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <SceneShell kicker="THE MANDATE" frame={frame}>
      <div style={{display: 'flex', flexDirection: 'column', gap: 26, marginTop: 26}}>
        <BrowserCard url="the mandate — price ladder" height={330} frame={frame}>
          <StillView src="stills/s2-ladder.png" dur={SEGMENTS[1].slot} scaleFrom={1.0} scaleTo={1.05} tyFrom={0} tyTo={-8} />
        </BrowserCard>
        <div style={{display: 'flex', gap: 16, ...fadeUp(frame, 60, 14)}}>
          <Chip>ITEM · Secondhand iPhone 12 128GB</Chip>
          <Chip bg="#E3F0EC">TARGET · $360</Chip>
          <Chip bg="#FBE3D3">CEILING · $390 — hard cap</Chip>
        </div>
      </div>
      <div style={{marginTop: 'auto'}}>
        <Caption
          frame={frame}
          start={26}
          lines={[<>An item. A <TEAL>target price</TEAL>.</>, <>And a <HL>hard ceiling</HL>.</>]}
        />
      </div>
    </SceneShell>
  );
};

/* ---------------- Scene 3 · the leash ---------------- */
const S3: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <SceneShell kicker="THE LEASH" frame={frame}>
      <div style={{display: 'flex', flexDirection: 'column', gap: 26, marginTop: 26}}>
        <BrowserCard url="run it live — you set the mandate" height={335} frame={frame}>
          <StillView src="stills/s3-form.png" dur={SEGMENTS[2].slot} scaleFrom={1.0} scaleTo={1.05} tyFrom={0} tyTo={-6} />
        </BrowserCard>
        <div style={{display: 'flex', gap: 16, flexWrap: 'wrap', ...fadeUp(frame, 70, 14)}}>
          <Chip>Signed mandate · Ed25519</Chip>
          <Chip>Offers above it · clamped</Chip>
          <Chip>Deals above it · refused</Chip>
          <Chip bg="#FBE3D3">Kill switch · stops any session</Chip>
        </div>
      </div>
      <div style={{marginTop: 'auto'}}>
        <Caption
          frame={frame}
          start={24}
          lines={[<>The ceiling is a <HL>leash</HL>.</>, <>And <TEAL>code</TEAL> holds it.</>]}
        />
      </div>
    </SceneShell>
  );
};

/* ---------------- Scene 4 · reasoning in the open ---------------- */
const S4: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <SceneShell kicker="SERV REASONING · IN THE OPEN" frame={frame}>
      <BrowserCard url="live session — strategy plan and reasoning traces" height={600} frame={frame}>
        <StillView src="stills/s4-transcript.png" dur={SEGMENTS[3].slot} scaleFrom={1.02} scaleTo={1.07} tyFrom={0} tyTo={-200} />
      </BrowserCard>
      <Caption
        frame={frame}
        start={22}
        lines={[<>A <TEAL>strategy plan</TEAL> first.</>, <>Every move, <HL>explained</HL>.</>]}
      />
    </SceneShell>
  );
};

/* ---------------- Scene 5 · the enforcer ---------------- */
const S5: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <SceneShell kicker="THE ENFORCER" frame={frame}>
      <BrowserCard url="enforcement demo — a concession, capped by code" height={600} frame={frame}>
        <StillView src="stills/s5-enforce.png" dur={SEGMENTS[4].slot} scaleFrom={1.02} scaleTo={1.07} tyFrom={-40} tyTo={-250} />
      </BrowserCard>
      <Caption
        frame={frame}
        start={20}
        lines={[<>Enforcement is not a suggestion.</>, <><HL>The code decides.</HL></>]}
      />
    </SceneShell>
  );
};

/* ---------------- Scene 6 · the result ---------------- */
const LadderAnim: React.FC<{frame: number}> = ({frame}) => {
  // Schematic of the real hero session: list $450, closed $390, ceiling $390, target $360.
  const min = 248;
  const max = 450;
  const trackW = 1420;
  const x = (v: number) => ((v - min) / (max - min)) * trackW;
  const price = interpolate(frame, [16, 38, 60, 82, 104, 122], [450, 425, 410, 398, 390, 390], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const roundsLit = Math.min(8, Math.max(0, Math.floor((frame - 14) / 14)));
  const dealIn = interpolate(frame, [118, 132], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        width: 1620,
        borderRadius: 26,
        background: C.card,
        border: `3px solid ${C.line}`,
        boxShadow: '0 30px 60px rgba(33,26,16,0.20)',
        padding: '44px 52px 40px',
        ...fadeUp(frame, 4, 16),
      }}
    >
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline'}}>
        <div style={{fontWeight: 800, fontSize: 30, letterSpacing: 3, color: C.ink}}>
          THE NEGOTIATION, CONDENSED
        </div>
        <div style={{fontWeight: 600, fontSize: 24, color: C.inkSoft}}>8 rounds · serv-pro vs serv-mini</div>
      </div>

      <div style={{position: 'relative', height: 230, marginTop: 76}}>
        {/* track */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 72,
            width: trackW,
            height: 34,
            borderRadius: 8,
            background: '#E9DFC6',
            border: `2px solid ${C.sand}`,
          }}
        />
        {/* red zone past the ceiling, on top of the track */}
        <div
          style={{
            position: 'absolute',
            left: x(390),
            top: 72,
            width: trackW - x(390),
            height: 34,
            borderRadius: 8,
            background:
              'repeating-linear-gradient(45deg, rgba(192,57,43,0.38) 0 12px, rgba(192,57,43,0.14) 12px 24px)',
          }}
        />
        {/* target tick + label below */}
        <div style={{position: 'absolute', left: x(360) - 2, top: 54, width: 4, height: 70, background: C.teal}} />
        <div style={{position: 'absolute', left: x(360) - 64, top: 134, width: 128, textAlign: 'center', fontWeight: 800, fontSize: 23, color: C.tealDark}}>
          TARGET $360
        </div>
        {/* ceiling tick + label below, right of target */}
        <div style={{position: 'absolute', left: x(390) - 2, top: 54, width: 4, height: 70, background: C.red}} />
        <div style={{position: 'absolute', left: x(390) - 8, top: 134, width: 150, textAlign: 'center', fontWeight: 800, fontSize: 23, color: C.red}}>
          CEILING $390
        </div>
        {/* list label, far right below */}
        <div style={{position: 'absolute', right: 0, top: 134, fontWeight: 600, fontSize: 23, color: C.inkSoft}}>
          LIST $450
        </div>
        {/* moving price pin */}
        <div
          style={{
            position: 'absolute',
            left: x(price) - 17,
            top: 60,
            width: 34,
            height: 58,
            background: C.orange,
            border: `3px solid ${C.line}`,
            borderRadius: '50% 50% 50% 6px',
            transform: 'rotate(45deg)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: x(price) - 62,
            top: -6,
            width: 124,
            textAlign: 'center',
            fontWeight: 900,
            fontSize: 42,
            color: C.ink,
          }}
        >
          ${Math.round(price)}
        </div>
      </div>

      <div style={{display: 'flex', alignItems: 'center', gap: 12, marginTop: 26}}>
        <div style={{fontWeight: 800, fontSize: 24, letterSpacing: 2, color: C.inkSoft, marginRight: 8}}>ROUNDS</div>
        {Array.from({length: 8}).map((_, i) => (
          <div
            key={i}
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              border: `2px solid ${C.line}`,
              background: i < roundsLit ? C.teal : '#EFE7D2',
            }}
          />
        ))}
        <div
          style={{
            marginLeft: 'auto',
            opacity: dealIn,
            transform: `scale(${0.8 + dealIn * 0.2})`,
            background: C.greenBg,
            border: `2px solid ${C.green}`,
            color: C.green,
            fontWeight: 900,
            fontSize: 30,
            borderRadius: 999,
            padding: '10px 28px',
          }}
        >
          DEAL CLOSED $390 · SAVED $60
        </div>
      </div>
    </div>
  );
};

const S6: React.FC = () => {
  const frame = useCurrentFrame();
  const split = 150;
  const showResult = frame >= split;
  return (
    <SceneShell kicker="THE RESULT" frame={frame}>
      {!showResult ? (
        <>
          <LadderAnim frame={frame} />
          <Caption
            frame={frame}
            start={20}
            lines={[<>Eight rounds.</>, <>One <HL>hard ceiling</HL>.</>]}
            size={56}
          />
        </>
      ) : (
        <>
          <BrowserCard url="result — and the savings ledger" height={600} frame={frame - split} start={0}>
            <StillView src="stills/s6-result.png" dur={SEGMENTS[5].slot - split} scaleFrom={1.0} scaleTo={1.03} tyFrom={0} tyTo={-620} />
          </BrowserCard>
          <Caption
            frame={frame - split}
            start={8}
            lines={[<>Closed at <HL>$390</HL>. Saved <TEAL>$60</TEAL>.</>, <>Every deal, under its ceiling.</>]}
          />
        </>
      )}
    </SceneShell>
  );
};

/* ---------------- Scene 7 · local market mode ---------------- */
const S7: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <SceneShell kicker="LOCAL MARKET MODE" frame={frame}>
      <BrowserCard url="the same agent — in Bahasa Indonesia" height={600} frame={frame}>
        <StillView src="stills/s7-idr.png" dur={SEGMENTS[6].slot} scaleFrom={1.02} scaleTo={1.07} tyFrom={0} tyTo={-170} />
      </BrowserCard>
      <Caption
        frame={frame}
        start={16}
        lines={[<>Bahasa Indonesia. <TEAL>Rupiah</TEAL>.</>, <>Its <HL>home market</HL>.</>]}
      />
    </SceneShell>
  );
};

/* ---------------- Scene 8 · end card ---------------- */
const S8: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(160deg, ${C.paper} 0%, ${C.paperDeep} 100%)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 30,
        fontFamily: 'Poppins',
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 26, ...fadeUp(frame, 4, 16)}}>
        <div
          style={{
            width: 118,
            height: 118,
            borderRadius: 28,
            background: C.orange,
            border: `3px solid ${C.line}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#FFF',
            fontWeight: 900,
            fontSize: 74,
          }}
        >
          T
        </div>
        <div style={{fontWeight: 900, fontSize: 118, color: C.ink, letterSpacing: 2}}>TAWAR</div>
      </div>
      <div
        style={{
          fontWeight: 800,
          fontSize: 44,
          color: C.ink,
          textAlign: 'center',
          maxWidth: 1250,
          lineHeight: 1.25,
          ...fadeUp(frame, 18, 14),
        }}
      >
        The agent that haggles for you, and <span style={{color: C.orange}}>cannot overspend</span> your limit.
      </div>
      <div style={{width: 220, height: 4, background: C.sand, borderRadius: 2, ...fadeUp(frame, 30, 12)}} />
      <div
        style={{
          fontWeight: 800,
          fontSize: 30,
          letterSpacing: 4,
          color: C.inkSoft,
          textAlign: 'center',
          ...fadeUp(frame, 36, 14),
        }}
      >
        SERV HACKATHON 02 · KITE TRACK
      </div>
      <div style={{fontWeight: 600, fontSize: 25, color: C.inkSoft, ...fadeUp(frame, 44, 14)}}>
        Built with SERV Reasoning
      </div>
    </AbsoluteFill>
  );
};

const SCENES = [S1, S2, S3, S4, S5, S6, S7, S8];

export const TawarDemo: React.FC = () => {
  usePoppins();
  let from = 0;
  return (
    <AbsoluteFill style={{background: C.paper}}>
      {SEGMENTS.map((seg, i) => {
        const Scene = SCENES[i];
        const start = from;
        from += seg.slot;
        return (
          <Sequence key={seg.n} from={start} durationInFrames={seg.slot}>
            <Scene />
            <Audio src={staticFile(seg.vo)} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
