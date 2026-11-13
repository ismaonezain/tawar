export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const W = WIDTH;
export const H = HEIGHT;

// Slot = VO duration (Liam, measured) + tail, in frames @30fps
// s1 3.62s=109 -> 132 | s2 9.29s=279 -> 292 | s3 10.82s=325 -> 338
// s4 11.05s=332 -> 345 | s5 8.22s=247 -> 260 | s6 8.87s=266 -> 340 (ladder anim + result)
// s7 5.06s=152 -> 168 | s8 2.83s=85 -> 150 (end card hold)
export interface SegSlot {
  n: number;
  vo: string;
  slot: number;
}

export const SEGMENTS: SegSlot[] = [
  {n: 1, vo: 'vo/seg1.mp3', slot: 132},
  {n: 2, vo: 'vo/seg2.mp3', slot: 292},
  {n: 3, vo: 'vo/seg3.mp3', slot: 338},
  {n: 4, vo: 'vo/seg4.mp3', slot: 345},
  {n: 5, vo: 'vo/seg5.mp3', slot: 260},
  {n: 6, vo: 'vo/seg6.mp3', slot: 340},
  {n: 7, vo: 'vo/seg7.mp3', slot: 168},
  {n: 8, vo: 'vo/seg8.mp3', slot: 150},
];

export const TOTAL_FRAMES = SEGMENTS.reduce((a, s) => a + s.slot, 0);
