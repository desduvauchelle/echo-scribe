import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { Ch1, Ch2, Ch3, Close, Open } from "./scenes";
import { TabCounter } from "./brain";
import { Flash, Grain } from "./fx";
import { C } from "./theme";
import { CUE, SFX, T, VO, musicVolume, sec } from "./timeline";

const Scene: React.FC<{ from: number; to: number; children: React.ReactNode; name: string }> = ({ from, to, children, name }) => (
  <Sequence from={sec(from)} durationInFrames={sec(to) - sec(from)} name={name}>{children}</Sequence>
);

export const Film: React.FC = () => (
  <AbsoluteFill style={{ background: C.cream }}>
    <Scene from={T.open} to={T.ch1} name="0 One thing"><Open /></Scene>
    <Scene from={T.ch1} to={T.ch2} name="1 The loop"><Ch1 /></Scene>
    <Scene from={T.ch2} to={T.ch3} name="2 Hand it off"><Ch2 /></Scene>
    <Scene from={T.ch3} to={T.close} name="3 Today's focus"><Ch3 /></Scene>
    <Scene from={T.close} to={T.total} name="Close"><Close /></Scene>
    <TabCounter hideFrom={sec(CUE.logo)} />
    <Flash at={sec(CUE.logo)} color={C.cream} max={1} length={14} />
    <Grain opacity={0.035} />
    <Audio src={staticFile("music/bed.wav")} volume={(f) => musicVolume(f)} />
    {VO.map((l) => (
      <Sequence key={l.id} from={sec(l.start)} name={`VO ${l.id}`}><Audio src={staticFile(`vo/n-${l.id}.wav`)} volume={1} /></Sequence>
    ))}
    {SFX.map((s, i) => (
      <Sequence key={i} from={sec(s.at)} name={`SFX ${s.file}`}><Audio src={staticFile(`sfx/${s.file}.wav`)} volume={s.vol} /></Sequence>
    ))}
  </AbsoluteFill>
);
