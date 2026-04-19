---
name: remotion
description: "Use when: analyzing, reviewing, or generating Remotion code. Guides the agent to use proper Remotion hooks (useCurrentFrame, useVideoConfig, spring, interpolate) instead of standard React state hooks to ensure deterministic video rendering."
---

# Remotion Video Development Skill

Use this skill when the user is asking to build or adapt video generation code using the `remotion` framework. This is critical for getting motion-graphics code right without breaking Remotion's rules.

## Core Rules
1. **Never use React State or Effects**: `useState` and `useEffect` are forbidden. Remotion computes an entire video at once by rendering every frame independently. The UI must be a pure function of the current frame.
2. **Always Use `useCurrentFrame`**: Import `useCurrentFrame` from `remotion` to get the current frame number (a time variable equivalent) to drive motion.
3. **Use the Config hook**: Import `useVideoConfig` from `remotion` for `{ fps, durationInFrames, width, height }`.
4. **Use Built-in Animation Helpers**:
   - `interpolate(frame, [input1, input2], [output1, output2], { extrapolateRight: "clamp" })`
   - `spring({ fps, frame, config: { damping: 10 } })`
   - `random("seed")` (Never use `Math.random()`)
5. **Timeline Components**:
   - Use `<Sequence from={20} durationInFrames={30}>` to delay elements and trim duration.
   - Use `<Series>` for placing elements completely back-to-back.
   - Always wrap scenes in `<AbsoluteFill>` to establish 100% width/height.
