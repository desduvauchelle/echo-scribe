import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { Act1, Act2, Act3, Close, Open } from "./scenes";
import { Flash, Grain } from "./fx";
import { C } from "./theme";
import { CUE, SFX, T, VO, musicVolume, sec } from "./timeline";

const Scene: React.FC<{ from: number; to: number; children: React.ReactNode; name: string }> = ({ from, to, children, name }) => (
  <Sequence from={sec(from)} durationInFrames={sec(to) - sec(from)} name={name}>{children}</Sequence>
);

export const Film: React.FC = () => (
  <AbsoluteFill style={{ background: "#120c10" }}>
    <Scene from={T.open} to={T.a1} name="0 The key"><Open /></Scene>
    <Scene from={T.a1} to={T.a2} name="1 Superwhisper"><Act1 /></Scene>
    <Scene from={T.a2} to={T.a3} name="2 Wispr Flow"><Act2 /></Scene>
    <Scene from={T.a3} to={T.close} name="3 Tucky"><Act3 /></Scene>
    <Scene from={T.close} to={T.total} name="Close"><Close /></Scene>
    <Flash at={sec(CUE.logo)} color={C.cream} max={1} length={14} />
    <Grain opacity={0.05} />
    <Audio src={staticFile("music/bed.wav")} volume={(f) => musicVolume(f)} />
    {VO.map((l) => (
      <Sequence key={l.id} from={sec(l.start)} name={`VO ${l.id}`}><Audio src={staticFile(`vo/n-${l.id}.wav`)} volume={1} /></Sequence>
    ))}
    {SFX.map((s, i) => (
      <Sequence key={i} from={sec(s.at)} name={`SFX ${s.file}`}><Audio src={staticFile(`sfx/${s.file}.wav`)} volume={s.vol} /></Sequence>
    ))}
  </AbsoluteFill>
);
