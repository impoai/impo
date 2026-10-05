#!/usr/bin/env python3
"""Render a narrated walkthrough of real app captures, with separate subtitles."""
from pathlib import Path
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / "docs/product-hunt"
WORK = ROOT / ".local/product-hunt/video"
WORK.mkdir(parents=True, exist_ok=True)
SCENES = [
    ("01-meet-impo", "Meet Impo, your open-source personal agent. Remember what matters, get things done, and find your next good buy."),
    ("02-shopping", "Looking for a commuter backpack under a hundred and fifty dollars? Impo finds products and helps you compare. Explore photos, prices, and details, then open the merchant to buy."),
    ("03-echo", "Capture a thought with Echo on your phone. Come back to the transcript, and choose which speech is yours before it becomes personal context."),
    ("04-memory", "Impo brings useful memories into your next conversation. You can browse what it remembers and forget what you no longer want kept."),
    ("05-tasks", "Give research, planning, or a first draft its own task. Work continues when you leave the app. Schedule recurring tasks, too."),
    ("06-feed", "Your Feed turns the context you share into useful next steps. A little perspective for the day ahead."),
    ("07-your-choice", "Connections and phone permissions are optional. The clients and backend are open source, so you can explore how Impo works."),
    ("08-start", "Try Impo on the web or Android. iOS is in TestFlight, with public access pending. What can your personal agent help with today?"),
]

def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()

def timestamp(seconds):
    milliseconds = round(seconds * 1000)
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"

timeline = []
captions = []
offset = 0.0
for index, (name, narration) in enumerate(SCENES):
    speech = WORK / f"{name}.txt"
    speech.write_text(narration + "\n")
    voice = WORK / f"{name}.aiff"
    run(["say", "-v", "Samantha", "-r", "164", "-f", str(speech), "-o", str(voice)])
    voice_duration = float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(voice)]))
    duration = round(voice_duration + 0.8, 3)
    clip = WORK / f"{name}.mp4"
    background = "0x244E40" if index in (0, 3, 6) else "0xF3EDDF"
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "30",
         "-i", str(KIT / f"assets/{name}.png"), "-i", str(voice),
         "-vf", f"scale=-2:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:0:color={background},setsar=1,fade=t=in:st=0:d=0.25,fade=t=out:st={duration-0.25}:d=0.25",
         "-af", "adelay=180|180,apad", "-t", str(duration), "-c:v", "libx264", "-preset", "fast",
         "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", str(clip)])
    timeline.append({"scene": name, "start": round(offset, 3), "duration": duration, "narration": narration})
    sentences = [s.strip() for s in narration.split(". ") if s.strip()]
    total_chars = sum(len(s) for s in sentences)
    cue_start = offset + 0.18
    for sentence in sentences:
        cue_duration = voice_duration * len(sentence) / total_chars
        captions.append(f"{len(captions)+1}\n{timestamp(cue_start)} --> {timestamp(cue_start+cue_duration)}\n{sentence.rstrip('.')}.\n")
        cue_start += cue_duration
    offset += duration
    print(f"Rendered {index+1}/8: {name} ({duration:.1f}s)", flush=True)

concat = WORK / "clips.txt"
concat.write_text("".join(f"file '{(WORK / (name + '.mp4')).as_posix()}'\n" for name, _ in SCENES))
subtitles = KIT / "assets/impo-walkthrough.en.srt"
subtitles.write_text("\n".join(captions))
run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
     "-i", str(subtitles), "-map", "0:v", "-map", "0:a", "-map", "1:0", "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
     "-metadata:s:s:0", "language=eng", "-metadata", "title=Meet Impo: your personal agent for life and shopping",
     "-movflags", "+faststart", str(KIT / "assets/impo-walkthrough-1080p.mp4")])
(KIT / "video-timeline.json").write_text(json.dumps(timeline, indent=2) + "\n")
print(f"Complete: {offset:.1f} seconds, 1080p, English narration and subtitles.")
