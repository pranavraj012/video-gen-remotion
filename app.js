import 'dotenv/config';
import { Sandbox } from 'e2b';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const SYSTEM_PROMPT = `You are an expert React developer writing Remotion videos.
You MUST use your provided Tools (Remotion MCP) to look up documentation and formatting if you don't confidently know how to implement Remotion hooks.
Generate ONLY a valid Remotion React component (MyVideo.tsx) based on the user's script.
The code should be a complete, self-contained valid React file exporting a component named 'MyVideo'.
Make sure to use a NAMED export: \`export const MyVideo: React.FC = () => { ... }\` (DO NOT use default export).
Do not wrap your answer in markdown code blocks or any explanation. ONLY output the raw file content.

MOTION REQUIREMENTS (MANDATORY):
- Use \`useCurrentFrame\` and \`useVideoConfig\`.
- Use at least 2 calls to \`interpolate(...)\` and at least 1 call to \`spring(...)\`.
- Use \`<Sequence>\` for at least 3 timed scenes.
- Animate at least: opacity, translateY/translateX, and scale.
- Do not generate static slides.

IMPORTANT REMOTION RULES:
1. ALWAYS import EXACTLY the functions you use from 'remotion'.
2. Do not use React state or effects.
3. CRITICAL: The 'remotion' library does NOT export a Text component.
4. Use only standard HTML tags and inline style objects.

CONTEXT7 REMOTION GUIDANCE:
- Use \`useVideoConfig()\` width/height for responsive layout; avoid oversized fixed cards and clipped text.
- Place audio in \`public/\` and use \`<Html5Audio src={staticFile(...)} />\`.
- Use \`<Sequence from={...} durationInFrames={...}>\` for explicit timeline control.
- For natural transitions, \`Html5Audio\` volume may be frame-based using \`interpolate\`.
`;

const escapeForTsString = (value) => value.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
const cleanScript = (value) => (value || '').replace(/\s+/g, ' ').trim();

const extractTopic = (value) => {
  const text = cleanScript(value);
  if (!text) return '';

  const topicMatch = text.match(/topic\s*:\s*(.+?)(?:\.|$)/i);
  if (topicMatch?.[1]) {
    return cleanScript(topicMatch[1]);
  }

  return text
    .replace(/^create\s+a\s+\d+\s*[- ]?second\s+vertical\s+educational\s+video\s+for\s+the\s+topic\s*:?\s*/i, '')
    .replace(/\.?\s*use\s+strong\s+motion\s+and\s+clear\s+visuals\.?$/i, '')
    .trim();
};

const toTitleCase = (value) =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');

const toSentence = (value) => {
  const text = cleanScript(value);
  if (!text) return '';
  return text[0].toUpperCase() + text.slice(1);
};

const deriveLessonContent = (script) => {
  const normalized = extractTopic(script);
  const topic = normalized.slice(0, 90) || 'A Useful Concept';
  const topicSentence = toSentence(topic);
  const topicTitle = toTitleCase(topic.replace(/[.?!]$/, '').slice(0, 60));

  const scenes = [
    {
      title: `Core Idea: ${topicTitle}`,
      body: `${topicSentence} in plain language with one mental model you can reuse.`,
    },
    {
      title: 'Why It Matters',
      body: 'It improves decision-making around correctness, performance, and implementation trade-offs.',
    },
    {
      title: 'How To Apply It',
      body: 'Start with a tiny example, verify edge cases, and then scale the same pattern to real code.',
    },
    {
      title: 'Practice Loop',
      body: `Summarize ${topic.toLowerCase()} in your own words, then build one short exercise today.`,
    },
  ];

  const narrationScript = [
    `Welcome. In this one-minute visual lesson, we are learning ${topic.toLowerCase()}.`,
    `First, the core idea. ${topicSentence} with one clear mental model that helps you reason quickly.`,
    `Second, why it matters. This concept helps you choose better solutions for reliability and speed.`,
    'Third, practical application. Begin with a small example, test edge cases, and scale the same approach to production.',
    'Finally, practice. Explain it simply, then implement one tiny exercise so the idea sticks.',
    'Quick recap. Understand the core idea, connect it to outcomes, apply it carefully, and reinforce it with deliberate practice.',
  ].join(' ');

  return {
    topicTitle,
    subtitle: `A visual breakdown of ${topic.toLowerCase()}`,
    scenes,
    summaryLine: 'Understand, connect, apply, and practice.',
    narrationScript,
  };
};

const pcm16ToWav = (pcmData, sampleRate = 24000, channels = 1, bitsPerSample = 16) => {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmData.length;
  const riffChunkSize = 36 + dataSize;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(riffChunkSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmData.copy(wav, 44);

  return wav;
};

const makeSilentWav = (durationSec, sampleRate = 24000) => {
  const sampleCount = Math.max(1, Math.floor(durationSec * sampleRate));
  const silentPcm = Buffer.alloc(sampleCount * 2);
  return pcm16ToWav(silentPcm, sampleRate, 1, 16);
};

const ttsCacheDir = path.join(process.cwd(), '.tts-cache');

const ensureTtsCacheDir = () => {
  if (!fs.existsSync(ttsCacheDir)) {
    fs.mkdirSync(ttsCacheDir, { recursive: true });
  }
};

const getTtsCachePath = ({ model, voice, text }) => {
  const hash = crypto
    .createHash('sha256')
    .update(`${model}|${voice}|${text}`)
    .digest('hex')
    .slice(0, 24);
  return path.join(ttsCacheDir, `${hash}.wav`);
};

const buildVoiceTrackDescriptors = (script, durationSec) => {
  const { narrationScript } = deriveLessonContent(script);
  return [
    {
      index: 0,
      fileName: 'voiceover-main.wav',
      startSec: 0,
      windowSec: Math.max(1, durationSec),
      text: narrationScript,
    },
  ];
};

const generateVoiceoverTracks = async (script, durationSec) => {
  const descriptors = buildVoiceTrackDescriptors(script, durationSec);
  ensureTtsCacheDir();

  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not set. Falling back to silent voiceover track.');
    return descriptors.map((track) => ({
      ...track,
      wavBuffer: makeSilentWav(track.windowSec),
      mode: 'silent-fallback',
    }));
  }

  const voiceStart = Date.now();
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const voiceModel = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
  const voiceName = process.env.GEMINI_TTS_VOICE || 'Kore';
  const tracks = [];

  try {
    console.log(`Generating narration with ${voiceModel} (voice=${voiceName})...`);
    for (const descriptor of descriptors) {
      const cachePath = getTtsCachePath({ model: voiceModel, voice: voiceName, text: descriptor.text });
      if (fs.existsSync(cachePath)) {
        const cachedWav = fs.readFileSync(cachePath);
        tracks.push({ ...descriptor, wavBuffer: cachedWav, mode: 'cache' });
        console.log(`Narration loaded from cache (${cachedWav.length} bytes)`);
        continue;
      }

      const prompt = `Narrate naturally and continuously for about ${Math.max(6, descriptor.windowSec - 1).toFixed(1)} seconds with minimal pauses. Script: ${descriptor.text}`;
      const response = await ai.models.generateContent({
        model: voiceModel,
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });

      const base64Audio = response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        tracks.push({ ...descriptor, wavBuffer: makeSilentWav(descriptor.windowSec), mode: 'silent-segment' });
        continue;
      }

      const pcmData = Buffer.from(base64Audio, 'base64');
      const wavBuffer = pcm16ToWav(pcmData, 24000, 1, 16);
      fs.writeFileSync(cachePath, wavBuffer);
      tracks.push({ ...descriptor, wavBuffer, mode: 'tts' });
      const pcmSeconds = (pcmData.length / 2 / 24000).toFixed(2);
      console.log(`Narration generated clip=${pcmSeconds}s cache=${path.basename(cachePath)}`);
    }

    console.log(`Voiceover generated in ${((Date.now() - voiceStart) / 1000).toFixed(1)}s (tracks=${tracks.length})`);
    return tracks;
  } catch (error) {
    console.warn(`Voiceover generation failed after ${((Date.now() - voiceStart) / 1000).toFixed(1)}s. Using silent fallback.`);
    const errorText = error?.message || String(error);
    if (errorText.includes('RESOURCE_EXHAUSTED') || errorText.includes('quota')) {
      console.warn('Gemini TTS quota exhausted. Reusing cache if available; otherwise silent fallback will be used.');
    }
    console.warn(errorText);
    return descriptors.map((track) => ({
      ...track,
      wavBuffer: makeSilentWav(track.windowSec),
      mode: 'silent-fallback',
    }));
  }
};

const hasDynamicAnimations = (code) => {
  const checks = [
    /useCurrentFrame\s*\(/,
    /useVideoConfig\s*\(/,
    /spring\s*\(\s*\{[\s\S]*?frame\s*:/,
    /interpolate\s*\(/,
    /<Sequence\b/,
    /transform\s*:\s*`[^`]*translate[XY]?\(/,
  ];
  return checks.every((regex) => regex.test(code));
};

const buildTopicLessonComponent = (script) => {
  const content = deriveLessonContent(script);
  const title = escapeForTsString(content.topicTitle);
  const subtitle = escapeForTsString(content.subtitle);
  const scene1Title = escapeForTsString(content.scenes[0].title);
  const scene1Body = escapeForTsString(content.scenes[0].body);
  const scene2Title = escapeForTsString(content.scenes[1].title);
  const scene2Body = escapeForTsString(content.scenes[1].body);
  const scene3Title = escapeForTsString(content.scenes[2].title);
  const scene3Body = escapeForTsString(content.scenes[2].body);
  const scene4Title = escapeForTsString(content.scenes[3].title);
  const scene4Body = escapeForTsString(content.scenes[3].body);
  const summaryLine = escapeForTsString(content.summaryLine);

  return `import { AbsoluteFill, Html5Audio, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

export const MyVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width } = useVideoConfig();

  const s1 = Math.floor(durationInFrames * 0.16);
  const s2 = Math.floor(durationInFrames * 0.36);
  const s3 = Math.floor(durationInFrames * 0.56);
  const s4 = Math.floor(durationInFrames * 0.76);
  const s5 = Math.floor(durationInFrames * 0.92);

  const cardWidth = Math.min(width * 0.9, 760);
  const cardPadding = Math.max(22, Math.floor(width * 0.045));
  const titleSize = Math.max(44, Math.min(76, Math.floor(width * 0.115)));
  const subtitleSize = Math.max(20, Math.min(34, Math.floor(width * 0.05)));
  const sceneTitleSize = Math.max(34, Math.min(54, Math.floor(width * 0.082)));
  const sceneBodySize = Math.max(21, Math.min(32, Math.floor(width * 0.048)));

  const progress = interpolate(frame, [0, durationInFrames], [6, 100], { extrapolateRight: "clamp" });
  const bgDriftX = interpolate(frame, [0, durationInFrames], [0, 150], { extrapolateRight: "clamp" });
  const bgDriftY = interpolate(frame, [0, durationInFrames], [0, -80], { extrapolateRight: "clamp" });
  const introSpring = spring({ fps, frame, config: { damping: 15, stiffness: 95 } });

  const sceneCard = (bg: string) => ({
    width: cardWidth,
    padding: cardPadding,
    borderRadius: Math.max(18, Math.floor(width * 0.035)),
    background: bg,
    border: "1px solid rgba(255,255,255,0.2)",
    boxShadow: "0 22px 55px rgba(0,0,0,0.30)",
    backdropFilter: "blur(3px)",
  });

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(165deg, #0a1233 0%, #08102a 42%, #050914 100%)",
        color: "#f7f9ff",
        fontFamily: "'Trebuchet MS', 'Segoe UI', sans-serif",
        overflow: "hidden",
      }}
    >
      <Html5Audio
        src={staticFile("voiceover-main.wav")}
        volume={(f) => interpolate(f, [0, 20, durationInFrames - 24, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
      />

      <AbsoluteFill
        style={{
          background:
            "radial-gradient(50% 60% at 15% 20%, rgba(79,225,255,0.22), transparent 75%), radial-gradient(44% 55% at 82% 70%, rgba(90,255,188,0.16), transparent 78%)",
          transform: "translate(" + (-bgDriftX) + "px," + bgDriftY + "px)",
          opacity: 0.92,
        }}
      />

      <AbsoluteFill
        style={{
          opacity: 0.12,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.2) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.2) 1px, transparent 1px)",
          backgroundSize: Math.max(42, Math.floor(width * 0.085)) + "px " + Math.max(42, Math.floor(width * 0.085)) + "px",
          transform: "translateX(" + (-bgDriftX * 0.4) + "px)",
        }}
      />

      <div style={{ position: "absolute", top: Math.max(18, width * 0.04), left: Math.max(18, width * 0.04), right: Math.max(18, width * 0.04), height: 9, borderRadius: 999, border: "2px solid rgba(255,255,255,0.28)" }}>
        <div style={{ width: progress + "%", height: "100%", borderRadius: 999, background: "linear-gradient(90deg, #5be6ff, #8cf8cb)" }} />
      </div>

      <Sequence from={0} durationInFrames={s1}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "0 " + Math.max(20, Math.floor(width * 0.06)) + "px",
            transform: "translateY(" + interpolate(frame, [0, Math.max(20, Math.floor(s1 * 0.45))], [58, 0], { extrapolateRight: "clamp" }) + "px) scale(" + (0.95 + introSpring * 0.05) + ")",
            opacity: interpolate(frame, [0, Math.max(10, Math.floor(s1 * 0.3))], [0, 1], { extrapolateRight: "clamp" }),
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: titleSize, lineHeight: 1.04, letterSpacing: -0.8 }}>{"${title}"}</h1>
            <p style={{ margin: "12px 0 0", fontSize: subtitleSize, opacity: 0.9 }}>{"${subtitle}"}</p>
          </div>
        </div>
      </Sequence>

      <Sequence from={s1} durationInFrames={s2 - s1}>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              ...sceneCard("rgba(27,57,112,0.70)"),
              opacity: interpolate(frame, [s1, s1 + Math.max(10, Math.floor((s2 - s1) * 0.22))], [0, 1], { extrapolateRight: "clamp" }),
              transform: "translateY(" + interpolate(frame, [s1, s1 + Math.max(14, Math.floor((s2 - s1) * 0.32))], [55, 0], { extrapolateRight: "clamp" }) + "px)",
            }}
          >
            <h2 style={{ margin: 0, fontSize: sceneTitleSize, lineHeight: 1.05 }}>{"${scene1Title}"}</h2>
            <p style={{ margin: "12px 0 0", fontSize: sceneBodySize, lineHeight: 1.25 }}>{"${scene1Body}"}</p>
          </div>
        </div>
      </Sequence>

      <Sequence from={s2} durationInFrames={s3 - s2}>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              ...sceneCard("rgba(15,93,118,0.70)"),
              opacity: interpolate(frame, [s2, s2 + Math.max(10, Math.floor((s3 - s2) * 0.22))], [0, 1], { extrapolateRight: "clamp" }),
              transform: "translateX(" + interpolate(frame, [s2, s2 + Math.max(14, Math.floor((s3 - s2) * 0.34))], [80, 0], { extrapolateRight: "clamp" }) + "px)",
            }}
          >
            <h2 style={{ margin: 0, fontSize: sceneTitleSize, lineHeight: 1.05 }}>{"${scene2Title}"}</h2>
            <p style={{ margin: "12px 0 0", fontSize: sceneBodySize, lineHeight: 1.25 }}>{"${scene2Body}"}</p>
          </div>
        </div>
      </Sequence>

      <Sequence from={s3} durationInFrames={s4 - s3}>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              ...sceneCard("rgba(24,106,76,0.70)"),
              opacity: interpolate(frame, [s3, s3 + Math.max(10, Math.floor((s4 - s3) * 0.22))], [0, 1], { extrapolateRight: "clamp" }),
              transform: "translateX(" + interpolate(frame, [s3, s3 + Math.max(14, Math.floor((s4 - s3) * 0.34))], [-80, 0], { extrapolateRight: "clamp" }) + "px)",
            }}
          >
            <h2 style={{ margin: 0, fontSize: sceneTitleSize, lineHeight: 1.05 }}>{"${scene3Title}"}</h2>
            <p style={{ margin: "12px 0 0", fontSize: sceneBodySize, lineHeight: 1.25 }}>{"${scene3Body}"}</p>
          </div>
        </div>
      </Sequence>

      <Sequence from={s4} durationInFrames={s5 - s4}>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              ...sceneCard("rgba(126,82,26,0.70)"),
              opacity: interpolate(frame, [s4, s4 + Math.max(10, Math.floor((s5 - s4) * 0.22))], [0, 1], { extrapolateRight: "clamp" }),
              transform: "translateY(" + interpolate(frame, [s4, s4 + Math.max(14, Math.floor((s5 - s4) * 0.34))], [55, 0], { extrapolateRight: "clamp" }) + "px)",
            }}
          >
            <h2 style={{ margin: 0, fontSize: sceneTitleSize, lineHeight: 1.05 }}>{"${scene4Title}"}</h2>
            <p style={{ margin: "12px 0 0", fontSize: sceneBodySize, lineHeight: 1.25 }}>{"${scene4Body}"}</p>
          </div>
        </div>
      </Sequence>

      <Sequence from={s5} durationInFrames={durationInFrames - s5}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "0 " + Math.max(20, Math.floor(width * 0.07)) + "px",
            opacity: interpolate(frame, [s5, s5 + Math.max(12, Math.floor((durationInFrames - s5) * 0.4))], [0, 1], { extrapolateRight: "clamp" }),
            transform: "scale(" + interpolate(frame, [s5, durationInFrames], [0.92, 1], { extrapolateRight: "clamp" }) + ")",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: Math.max(38, Math.min(58, Math.floor(width * 0.085))) }}>From Idea To Execution</h2>
            <p style={{ margin: "10px 0 0", fontSize: Math.max(22, Math.min(30, Math.floor(width * 0.05))), opacity: 0.86 }}>{"${summaryLine}"}</p>
          </div>
        </div>
      </Sequence>
    </AbsoluteFill>
  );
};`;
};

const buildFallbackAnimatedComponent = (script) => {
  const title = escapeForTsString(extractTopic(script).slice(0, 90) || 'Dynamic Remotion Video');
  return `import { AbsoluteFill, Html5Audio, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

export const MyVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width } = useVideoConfig();

  const sceneIn = spring({ frame, fps, config: { damping: 14, stiffness: 120 } });
  const titleY = interpolate(frame, [0, 30], [90, 0], { extrapolateRight: "clamp" });
  const titleOpacity = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });
  const pulse = 1 + 0.04 * Math.sin(frame / 6);
  const barWidth = interpolate(frame, [0, durationInFrames], [8, 100], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        background: "radial-gradient(circle at 20% 20%, #1f2a44 0%, #0b1020 45%, #05070f 100%)",
        color: "#f7f8ff",
        fontFamily: "'Segoe UI', sans-serif",
        padding: Math.max(30, Math.floor(width * 0.06)),
      }}
    >
      <Html5Audio
        src={staticFile("voiceover-main.wav")}
        volume={(f) => interpolate(f, [0, 18, durationInFrames - 20, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
      />

      <Sequence from={0} durationInFrames={Math.floor(durationInFrames * 0.3)}>
        <div
          style={{
            marginTop: Math.max(80, Math.floor(width * 0.18)),
            fontSize: Math.max(44, Math.min(74, Math.floor(width * 0.11))),
            fontWeight: 800,
            lineHeight: 1.05,
            letterSpacing: -1,
            opacity: titleOpacity,
            transform: "translateY(" + titleY + "px) scale(" + (0.92 + sceneIn * 0.08) + ")",
          }}
        >
          ${title}
        </div>
      </Sequence>

      <Sequence from={Math.floor(durationInFrames * 0.24)} durationInFrames={Math.floor(durationInFrames * 0.36)}>
        <div
          style={{
            marginTop: 28,
            maxWidth: Math.floor(width * 0.9),
            fontSize: Math.max(24, Math.floor(width * 0.055)),
            opacity: interpolate(frame, [Math.floor(durationInFrames * 0.24), Math.floor(durationInFrames * 0.28)], [0, 1], { extrapolateRight: "clamp" }),
            transform: "translateX(" + interpolate(frame, [Math.floor(durationInFrames * 0.24), Math.floor(durationInFrames * 0.32)], [70, 0], { extrapolateRight: "clamp" }) + "px)",
          }}
        >
          Dynamic motion powered by frame-based animation curves and timeline-aware sequencing.
        </div>
      </Sequence>

      <Sequence from={Math.floor(durationInFrames * 0.58)} durationInFrames={Math.floor(durationInFrames * 0.24)}>
        <div
          style={{
            marginTop: 40,
            width: "100%",
            height: 18,
            borderRadius: 999,
            border: "2px solid rgba(255,255,255,0.35)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: barWidth + "%",
              background: "linear-gradient(90deg, #4fe1ff 0%, #8ef7c8 100%)",
              transform: "scale(" + pulse + ")",
              transformOrigin: "left center",
            }}
          />
        </div>
      </Sequence>
    </AbsoluteFill>
  );
};`;
};

async function generateReactCode(script) {
  if (process.env.USE_GEMINI_CODE !== '1') {
    console.log('Using stable agent-authored Remotion component (set USE_GEMINI_CODE=1 to enable Gemini codegen).');
    return buildTopicLessonComponent(script);
  }

  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not set. Using agent-authored Remotion template fallback.');
    return buildTopicLessonComponent(script);
  }

  console.log('Generating React code with Google GenAI SDK...');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [{ text: `${SYSTEM_PROMPT}\n\nUSER SCRIPT:\n${script}` }],
      },
    ],
  });

  let code = (response.text || '').trim();
  if (!code) {
    console.warn('Gemini returned empty code. Using agent-authored Remotion template fallback.');
    return buildTopicLessonComponent(script);
  }

  if (code.startsWith('```')) {
    const lines = code.split('\n');
    lines.shift();
    if (lines[lines.length - 1].startsWith('```')) lines.pop();
    code = lines.join('\n');
  }

  if (code.includes('import {') || code.includes('import ')) {
    const idx = code.indexOf('import');
    code = code.substring(idx);
  }

  code = code.replace(/```tsx?/g, '').replace(/```/g, '');
  code = code.replace(/<Text\b/g, '<div');
  code = code.replace(/<\/Text>/g, '</div>');
  code = code.replace(/Text[,\s]*\}/g, '}');
  code = code.replace(/\{[,\s]*Text\s*,/g, '{');

  if (!hasDynamicAnimations(code)) {
    console.warn('WARN: Generated code is not dynamic enough. Falling back to built-in animated template.');
    code = buildFallbackAnimatedComponent(script);
  }

  return code;
}

async function renderVideo(topic, scriptPrompt) {
  let sbx;
  const startTime = Date.now();
  const formatElapsed = (sinceMs) => `${((Date.now() - sinceMs) / 1000).toFixed(1)}s`;
  const compositionWidth = Number(process.env.RENDER_WIDTH || 540);
  const compositionHeight = Number(process.env.RENDER_HEIGHT || 960);
  const compositionFps = Number(process.env.RENDER_FPS || 15);
  const compositionDurationInFrames = Number(process.env.RENDER_DURATION_IN_FRAMES || 900);
  const compositionDurationSec = compositionDurationInFrames / compositionFps;
  const sandboxTimeoutMs = Number(process.env.E2B_SANDBOX_TIMEOUT_MS || 30 * 60 * 1000);

  try {
    const generatedCode = await generateReactCode(scriptPrompt || topic);
    console.log('Successfully generated React code!');

    const voiceTracks = await generateVoiceoverTracks(topic, compositionDurationSec);
    console.log(`Voiceover tracks ready. count=${voiceTracks.length}, duration=${compositionDurationSec.toFixed(1)}s`);

    console.log('Starting E2B Sandbox...');
    sbx = await Sandbox.create('remotion-renderer-v2', {
      timeoutMs: sandboxTimeoutMs,
      metadata: {
        job: 'remotion-render',
        durationSec: String(compositionDurationSec),
      },
    });
    console.log(`Sandbox started with timeout=${(sandboxTimeoutMs / 1000).toFixed(0)}s`);

    await sbx.files.write('/home/user/remotion-app/remotion/MyVideo.tsx', generatedCode);
    for (const track of voiceTracks) {
      await sbx.files.write(`/home/user/remotion-app/public/${track.fileName}`, track.wavBuffer);
      console.log(`Uploaded ${track.fileName} (start=${track.startSec.toFixed(2)}s, mode=${track.mode}, bytes=${track.wavBuffer.length})`);
    }

    const rootContent = `
import { Composition } from "remotion";
import { MyVideo } from "./MyVideo";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="HelloWorld"
        component={MyVideo}
        durationInFrames={${compositionDurationInFrames}}
        fps={${compositionFps}}
        width={${compositionWidth}}
        height={${compositionHeight}}
      />
    </>
  );
};`;
    await sbx.files.write('/home/user/remotion-app/remotion/Root.tsx', rootContent.trim());

    console.log('Booting Remotion target Render Server (Express)...');
    await sbx.commands.run('npm start', {
      background: true,
      cwd: '/home/user/remotion-app',
      onStdout: (data) => console.log('[SERVER]', data),
      onStderr: (data) => console.error('[SERVER ERR]', data),
    });

    const host = await sbx.getHost(3000);
    console.log(`Waiting for bundle server to spin up at https://${host}...`);

    let serverReady = false;
    for (let i = 0; i < 30; i++) {
      try {
        const test = await sbx.commands.run('curl -sS --max-time 2 http://localhost:3000/renders >/dev/null');
        if (test.exitCode === 0) {
          serverReady = true;
          console.log('Server is accessible via health check!');
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!serverReady) {
      throw new Error('Render server did not become ready within 60s.');
    }

    await new Promise((r) => setTimeout(r, 3000));

    const postCmd = await sbx.commands.run(
      `curl -sS -X POST -H 'Content-Type: application/json' -d '{"titleText":"Generated reel"}' http://localhost:3000/renders`
    );
    if (postCmd.exitCode !== 0) {
      throw new Error('API POST Failed: ' + (postCmd.stderr || postCmd.stdout || `exitCode=${postCmd.exitCode}`));
    }

    const postJson = JSON.parse((postCmd.stdout || '').trim());
    const { jobId } = postJson;
    if (!jobId) {
      throw new Error('API POST Failed: missing jobId in response');
    }

    console.log(`Render Job ${jobId} registered. Polling...`);
    const renderStartTime = Date.now();
    const maxRenderMs = Number(process.env.RENDER_POLL_MAX_MS || 20 * 60 * 1000);
    const maxNoProgressMs = Number(process.env.RENDER_STALL_TIMEOUT_MS || 4 * 60 * 1000);
    const maxConsecutivePollErrors = Number(process.env.RENDER_MAX_CONSECUTIVE_POLL_ERRORS || 20);
    let lastProgressValue = -1;
    let lastProgressChangeAt = Date.now();
    let consecutivePollErrors = 0;

    let finalVideoUrl = null;
    while (true) {
      if (Date.now() - renderStartTime > maxRenderMs) {
        throw new Error(`Render polling exceeded max time (${(maxRenderMs / 1000).toFixed(0)}s).`);
      }

      await new Promise((r) => setTimeout(r, 2000));

      let statusData;
      try {
        const statusCmd = await sbx.commands.run(`curl -sS http://localhost:3000/renders/${jobId}`);
        if (statusCmd.exitCode !== 0) {
          throw new Error(`Status API exit ${statusCmd.exitCode}: ${statusCmd.stderr || statusCmd.stdout}`);
        }
        statusData = JSON.parse((statusCmd.stdout || '').trim());
        consecutivePollErrors = 0;
      } catch (pollErr) {
        consecutivePollErrors += 1;
        console.warn(`Status poll error ${consecutivePollErrors}/${maxConsecutivePollErrors}: ${pollErr?.message || pollErr}`);
        if (consecutivePollErrors >= maxConsecutivePollErrors) {
          throw new Error('Render polling failed repeatedly. Sandbox may have stopped or become unreachable.');
        }
        continue;
      }

      if (statusData.status === 'in-progress' || statusData.status === 'queued') {
        const rawProgress = typeof statusData.progress === 'number' ? statusData.progress : 0;
        const progressPct = Number((rawProgress * 100).toFixed(1));

        if (progressPct > lastProgressValue) {
          lastProgressValue = progressPct;
          lastProgressChangeAt = Date.now();
        }

        const timeSinceChange = ((Date.now() - lastProgressChangeAt) / 1000).toFixed(1);
        console.log(`Render Progress: ${progressPct}% | elapsed=${formatElapsed(renderStartTime)} | sinceLastChange=${timeSinceChange}s`);

        if (Date.now() - lastProgressChangeAt > maxNoProgressMs) {
          throw new Error(`Render stalled: no progress change for ${(maxNoProgressMs / 1000).toFixed(0)}s.`);
        }
      } else if (statusData.status === 'completed') {
        finalVideoUrl = statusData.videoUrl;
        console.log(`Render Finished Successfully! renderElapsed=${formatElapsed(renderStartTime)}`);
        break;
      } else if (statusData.status === 'failed') {
        throw new Error('Render job failed on server: ' + (statusData.error || 'Unknown error'));
      }
    }

    const pubUrl = finalVideoUrl.replace('http://localhost:3000', `https://${host}`);
    console.log('Downloading MP4 via endpoint URL...', finalVideoUrl);

    let outputBuffer;
    try {
      const bufferRes = await fetch(pubUrl);
      if (!bufferRes.ok) {
        throw new Error(`Download HTTP ${bufferRes.status}`);
      }
      outputBuffer = Buffer.from(await bufferRes.arrayBuffer());
    } catch (downloadErr) {
      console.warn(`External download failed (${downloadErr?.message || downloadErr}). Falling back to local file read.`);
      const localReadCmd = await sbx.commands.run(`base64 -w0 /home/user/remotion-app/renders/${jobId}.mp4`);
      if (localReadCmd.exitCode !== 0 || !localReadCmd.stdout) {
        throw new Error(`Local file read failed: ${localReadCmd.stderr || localReadCmd.stdout || `exitCode=${localReadCmd.exitCode}`}`);
      }
      outputBuffer = Buffer.from(localReadCmd.stdout.replace(/\s+/g, ''), 'base64');
    }

    const outputPath = path.join(process.cwd(), 'out_video.mp4');
    fs.writeFileSync(outputPath, outputBuffer);
    console.log(`Video saved locally to ${outputPath}`);
    console.log(`Total generation and render time: ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`);
  } catch (error) {
    console.error('Workflow failed:', error);
  } finally {
    if (sbx) await sbx.kill();
  }
}

const resolveRequestedTopic = () => {
  const cliScript = process.argv.slice(2).join(' ').trim();
  const envScript = cleanScript(process.env.VIDEO_TOPIC || process.env.VIDEO_SCRIPT || '');
  const defaultTopic = 'binary search intuition and implementation';

  if (cliScript) return extractTopic(cliScript);
  if (envScript) return extractTopic(envScript);
  return defaultTopic;
};

const buildGenerationPrompt = (topic, durationSec) => {
  const safeTopic = extractTopic(topic) || 'a practical software engineering concept';
  return `Create a ${Math.round(durationSec)}-second vertical educational video for the topic: ${safeTopic}. Use strong motion and clear visuals.`;
};

import { fileURLToPath } from 'url';

export { renderVideo, generateReactCode };

const requestedTopic = resolveRequestedTopic();
const requestedDurationFrames = Number(process.env.RENDER_DURATION_IN_FRAMES || 900);
const requestedFps = Number(process.env.RENDER_FPS || 15);
const requestedDurationSec = requestedDurationFrames / requestedFps;
const requestedPrompt = buildGenerationPrompt(requestedTopic, requestedDurationSec);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Video topic: ${requestedTopic}`);
  console.log(`Video topic prompt: ${requestedPrompt}`);
  
  // Quick fix: Immediately resolve process to avoid hanging due to any ESM issues, or run correctly.
  renderVideo(requestedTopic, requestedPrompt).then(() => {
    console.log('Finished CLI execution');
    process.exit(0);
  }).catch((e) => {
    console.error('Unhandled CLI Error:', e);
    process.exit(1);
  });
}
