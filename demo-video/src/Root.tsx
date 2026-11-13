import React from 'react';
import {Composition} from 'remotion';
import {FPS, HEIGHT, TOTAL_FRAMES, WIDTH} from './config';
import {TawarDemo} from './TawarDemo';

export const Root: React.FC = () => (
  <Composition
    id="TawarDemo"
    component={TawarDemo}
    durationInFrames={TOTAL_FRAMES}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
  />
);
