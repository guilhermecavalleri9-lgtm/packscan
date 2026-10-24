import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";

// Assets live in public/janeiro/ (gitignored: photos of real people).
export const janeiroMemeSchema = z.object({
  legenda: z.string(),
  textoFinal: z.string(),
});

const BPM = 139.5;
const FIRST_BEAT_S = 0.05;
const END_FRAME = 370; // start of the darkened outro, as in the reference

type Point = [number, number];

type Photo = {
  src: string;
  w: number;
  h: number;
  // Fractions of the image size.
  focus: Point;
};

const PESSOA_1: Photo = {
  src: "janeiro/pessoa1.jpg",
  w: 1512,
  h: 2016,
  focus: [0.39, 0.4],
};

const PESSOA_2: Photo = {
  src: "janeiro/pessoa2.jpg",
  w: 1932,
  h: 2576,
  focus: [0.22, 0.42],
};

const beatPhase = (frame: number, fps: number) => {
  const period = (fps * 60) / BPM;
  const t = (frame - FIRST_BEAT_S * fps) / period;
  return { index: Math.floor(t), phase: t - Math.floor(t) };
};

// Shows a photo cropped to the given box, centred on its focus point, bouncing on the beat.
const DancingPhoto: React.FC<{
  photo: Photo;
  boxW: number;
  boxH: number;
  zoom: number;
  beatOffset?: number;
}> = ({ photo, boxW, boxH, zoom, beatOffset = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { index, phase } = beatPhase(frame, fps);
  const side = (index + beatOffset) % 2 === 0 ? 1 : -1;

  const cover = Math.max(boxW / photo.w, boxH / photo.h);
  const dw = photo.w * cover * zoom;
  const dh = photo.h * cover * zoom;
  const left = Math.min(0, Math.max(boxW - dw, boxW / 2 - photo.focus[0] * dw));
  const top = Math.min(0, Math.max(boxH - dh, boxH / 2 - photo.focus[1] * dh));

  const kick = Math.exp(-phase * 5);
  const scale = 1 + 0.07 * kick;
  const rotate = side * 4 * Math.sin(Math.PI * phase);
  const bob = -30 * Math.sin(Math.PI * phase);
  const sway = side * 25 * Math.sin(Math.PI * phase);

  return (
    <div
      style={{
        position: "relative",
        width: boxW,
        height: boxH,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left,
          top,
          width: dw,
          height: dh,
          transformOrigin: `${photo.focus[0] * 100}% ${photo.focus[1] * 100}%`,
          transform: `translate(${sway}px, ${bob}px) rotate(${rotate}deg) scale(${scale * 1.08})`,
        }}
      >
        <Img
          src={staticFile(photo.src)}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </div>
  );
};

const scenes: { from: number; render: () => React.ReactNode }[] = [
  {
    from: 0,
    render: () => (
      <DancingPhoto photo={PESSOA_1} boxW={1080} boxH={1920} zoom={1.35} />
    ),
  },
  {
    from: 103,
    render: () => (
      <DancingPhoto photo={PESSOA_2} boxW={1080} boxH={1920} zoom={1} />
    ),
  },
  {
    from: 206,
    render: () => (
      <DancingPhoto photo={PESSOA_1} boxW={1080} boxH={1920} zoom={1.7} />
    ),
  },
  {
    from: 258,
    render: () => (
      <DancingPhoto photo={PESSOA_2} boxW={1080} boxH={1920} zoom={1.25} />
    ),
  },
  {
    from: 310,
    render: () => (
      <div style={{ display: "flex" }}>
        <DancingPhoto photo={PESSOA_1} boxW={540} boxH={1920} zoom={1.2} />
        <DancingPhoto
          photo={PESSOA_2}
          boxW={540}
          boxH={1920}
          zoom={1}
          beatOffset={1}
        />
      </div>
    ),
  },
];

const outline =
  "0 0 6px #000, 3px 3px 0 #000, -3px -3px 0 #000, 3px -3px 0 #000, -3px 3px 0 #000";

export const JaneiroMeme: React.FC<z.infer<typeof janeiroMemeSchema>> = ({
  legenda,
  textoFinal,
}) => {
  const frame = useCurrentFrame();
  const scene = [...scenes].reverse().find((s) => frame >= s.from)!;
  const dark = interpolate(frame, [END_FRAME, END_FRAME + 8], [0, 0.7], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const endPop = interpolate(frame, [END_FRAME, END_FRAME + 10], [0.6, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "black",
        fontFamily: "Helvetica, Arial, sans-serif",
      }}
    >
      <Audio src={staticFile("janeiro/musica.m4a")} />
      {scene.render()}
      <AbsoluteFill style={{ backgroundColor: `rgba(0,0,0,${dark})` }} />
      <div
        style={{
          position: "absolute",
          top: 300,
          width: "100%",
          padding: "0 140px",
          textAlign: "center",
          color: "white",
          fontSize: 60,
          fontWeight: 700,
          lineHeight: 1.15,
          textShadow: outline,
          opacity: 1 - dark,
        }}
      >
        {legenda}
      </div>
      {frame >= END_FRAME ? (
        <AbsoluteFill
          style={{ justifyContent: "center", alignItems: "center" }}
        >
          <div
            style={{
              color: "white",
              fontSize: 64,
              fontWeight: 800,
              textShadow: outline,
              transform: `scale(${endPop})`,
            }}
          >
            {textoFinal}
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
