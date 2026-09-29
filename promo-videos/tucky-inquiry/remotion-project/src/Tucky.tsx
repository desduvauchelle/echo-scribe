import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Ch1, Ch2, Ch3, Ch4, Ch5, Close } from "./scenes";
import { Flash, Grain } from "./fx";
import { CUE, SFX, T, VO, musicVolume, sec } from "./timeline";

const Scene: React.FC<{ from: number; to: number; children: React.ReactNode; name: string }> = ({ from, to, children, name }) => (
  <Sequence from={sec(from)} durationInFrames={sec(to) - sec(from)} name={name}>{children}</Sequence>
);

export const Tucky: React.FC = () => {
  const frame = useCurrentFrame();
  const dark = frame < sec(T.ch2) || (frame >= sec(T.close) && frame < sec(CUE.logo));
  return (
    <AbsoluteFill style={{ background: "#0b1712" }}>
      <Scene from={T.ch1} to={T.ch2} name="1 What if I just talked"><Ch1 /></Scene>
      <Scene from={T.ch2} to={T.ch3} name="2 Why am I still typing"><Ch2 /></Scene>
      <Scene from={T.ch3} to={T.ch4} name="3 Isn't this useful"><Ch3 /></Scene>
      <Scene from={T.ch4} to={T.ch5} name="4 What else does it know"><Ch4 /></Scene>
      <Scene from={T.ch5} to={T.close} name="5 Where does it live"><Ch5 /></Scene>
      <Scene from={T.close} to={T.total} name="Close"><Close /></Scene>
      <Flash at={sec(CUE.logo)} color="#fbf6ea" max={1} length={14} />
      <Grain opacity={dark ? 0.09 : 0.04} />
      <Audio src={staticFile("music/bed.wav")} volume={(f) => musicVolume(f)} />
      {VO.map((l) => (
        <Sequence key={l.id} from={sec(l.start)} name={`VO ${l.id}`}><Audio src={staticFile(`vo/n-hume-${l.id}.wav`)} volume={1} /></Sequence>
      ))}
      {SFX.map((s, i) => (
        <Sequence key={i} from={sec(s.at)} name={`SFX ${s.file}`}><Audio src={staticFile(`sfx/${s.file}.wav`)} volume={s.vol} /></Sequence>
      ))}
    </AbsoluteFill>
  );
};
