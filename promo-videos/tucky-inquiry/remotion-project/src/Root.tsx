import React from "react";
import { Composition, Still } from "remotion";
import { Tucky } from "./Tucky";
import { Thumbnail } from "./Thumbnail";
import { FPS, TOTAL_FRAMES } from "./timeline";

export const Root: React.FC = () => (
  <>
    <Composition id="Tucky" component={Tucky} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1920} height={1080} />
    <Still id="ThumbTalk" component={Thumbnail} width={1280} height={720} defaultProps={{ variant: "talk" }} />
    <Still id="ThumbFree" component={Thumbnail} width={1280} height={720} defaultProps={{ variant: "free" }} />
  </>
);
