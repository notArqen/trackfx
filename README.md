# PolyTrack FX

An **unofficial** graphics mod for PolyTrack. It keeps the game exactly as it is and replaces how it looks: a day and night
cycle, weather, wet roads with reflections, headlights, glowing kerbs, bloom, god rays, cinematic cameras and a photo mode.

**Play it: https://notarqen.github.io/trackfx/**

> **Unofficial.** This mod is not affiliated with, endorsed by, or sponsored by Kodub.com, CrazyGames, Poki or itch.io.
> PolyTrack is made by [Kodub.com](https://www.kodub.com). To play the original game, visit
> [the official page](https://www.crazygames.com/game/polytrack).

<!-- gallery: screenshots go here -->

## Quick start

1. Open the link above in a desktop browser (Chrome, Edge, Firefox or Safari with WebGL2).
2. The intro card lists the controls. Close it with Enter, Esc or the button. Press **H** any time to see it again.
3. Press **F9** to open the effects panel and change the time of day, the weather and everything else live.

Your settings are saved in your browser. **reset all** in the panel puts everything back to default, and **copy settings**
copies your current settings as JSON.

## Controls

| key | action |
| --- | --- |
| **F9** | open / close the effects panel |
| **H** | intro and controls screen (also the **?** button in the panel header) |
| **C** / shift+C | cycle camera views: chase variants, roof, side pods, wheels, rear wing, nose, bumper, ghost bumper |
| **K** | cinematic cameras on / off |
| **E** or **/** | headlights on / off |
| **P** | photo mode: free camera (press Space yourself to pause the race on the web build) |
| **shift+P** | instant photo, downloads a PNG |

In photo mode: WASD move, Q/E down/up, drag to look, mouse wheel for field of view, Z/X roll, shift for faster movement,
Tab to orbit the car, Enter to capture, Esc to exit.

## What it adds

Everything below is a slider or toggle in the F9 panel.

- **Time and sky:** time of day, sun direction, an optional day cycle, a procedural sky with sun, moon and stars.
- **Weather:** clear, cloudy, overcast, rain, storm (with lightning), hail and fog, each with an intensity. Rain falls as 3D streaks
  and drops run down the lens. Wet tracks darken and get puddles with sharp reflections.
- **Car lights:** headlights that actually light the road ahead, an LED strip, tail and brake lights with a red glow on the ground,
  and dimmer lights on ghost cars. They switch on at night, in rain and in tunnels, or by hand.
- **Light and shadow:** baked whole-track sun shadows, properly dark tunnels and covered sections, eye adaptation, volumetric god rays
  and ambient occlusion.
- **Night glow:** kerbs, arrows and signs glow at night and spill light onto the track.
- **Camera:** motion blur, a field-of-view kick at speed, and GoPro-style cameras with shake, impact shake, fisheye and edge blur.
- **Cinematic mode:** auto-cycling shots in replays and while driving: trackside, chase, orbit, helicopter, bumper and flyby, all
  with line-of-sight checks so the track never blocks the car.
- **Image:** filmic tonemap, exposure, contrast, saturation, vignette and bloom.
- **Photo mode:** a free or orbiting camera, with photos rendered at up to 5K on maximum settings.
- **Performance:** low, medium, high and ultra presets, render scale, FPS cap and sharpening.

## Performance

It is a lot of shader work. The **medium** preset renders at 75% scale and aims to keep a modern laptop or desktop GPU comfortable.
If it stutters, open the panel, go to *performance*, and drop the preset or the render scale. Turning off the master switch at the top of the
panel returns to the stock look.

## Notes on this web build

- **No leaderboards.** The game's server only accepts requests from its own origins, so scores cannot be submitted from here and
  nothing from this mod can reach them.
- **Photo mode does not auto-pause the race.** The desktop version of the mod does; a browser can't send the game that key press
  for you, so press Space to pause.
- Photos download as PNG files through your browser instead of saving to a folder.
- Desktop browsers only. Touch controls were not touched.

## Terms and credits

- **Non-commercial.** No ads, sponsorship, paid access or monetization of any kind.
- Published as a mod under Section 4 of the [PolyTrack Terms](https://www.kodub.com/terms/polytrack). The game's unofficial-mod
  notice and the kodub.com links are unaltered, and the page is set to `noindex`.
- **Game and assets:** the game code, models, tracks and sounds are © Kodub.com, all rights reserved. Only the FX layer (`ptfx/`) is
  by the mod author.
- **Music:** "Sci-fi Theme" by [Maou](https://opengameart.org/content/sci-fi-theme-1), licensed CC-BY 4.0.
- **Takedown:** Kodub.com or CrazyGames, if you want this removed, open an issue on this repo or contact the owner and it will be
  taken down promptly.
