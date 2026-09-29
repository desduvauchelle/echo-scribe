import React from "react";
import { Composition, Still } from "remotion";
import { Film } from "./Film";
import { Thumbnail } from "./Thumbnail";
import { FPS, TOTAL_FRAMES } from "./timeline";

export const Root: React.FC = () => (
  <>
    <Composition id="Film" component={Film} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1920} height={1080} />
    <Still id="Thumbnail" component={Thumbnail} width={1280} height={720} />
  </>
);
