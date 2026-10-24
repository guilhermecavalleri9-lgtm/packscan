import { Composition, staticFile } from "remotion";
import {
  CaptionedVideo,
  calculateCaptionedVideoMetadata,
  captionedVideoSchema,
} from "./CaptionedVideo";
import { JaneiroMeme, janeiroMemeSchema } from "./JaneiroMeme";

// Each <Composition> is an entry in the sidebar!

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="CaptionedVideo"
        component={CaptionedVideo}
        calculateMetadata={calculateCaptionedVideoMetadata}
        schema={captionedVideoSchema}
        width={1080}
        height={1920}
        defaultProps={{
          src: staticFile("sample-video.mp4"),
        }}
      />
      <Composition
        id="JaneiroMeme"
        component={JaneiroMeme}
        schema={janeiroMemeSchema}
        durationInFrames={534}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          legenda: "Dia primeiro de janeiro de 2027:",
          textoFinal: "PackScan 🇧🇷",
        }}
      />
    </>
  );
};
